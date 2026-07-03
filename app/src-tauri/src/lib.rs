use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

/// Platform-specific sidecar file names. Tauri places externalBin next to the
/// main executable, with a `.exe` suffix on Windows.
#[cfg(windows)]
mod plat {
    pub const VN: &str = "vn.exe";
    pub const BUN: &str = "bun.exe";
    pub const FFPROBE: &str = "ffprobe.exe";
}
#[cfg(not(windows))]
mod plat {
    pub const VN: &str = "vn";
    pub const BUN: &str = "bun";
    pub const FFPROBE: &str = "ffprobe";
}

/// Env the bundled engine needs to find its sibling runtimes. Dev resolves pi /
/// ffprobe from PATH; release points vn at the bundled bun + pi cli.js. pi can't
/// be --compile'd (it reads data files from disk) but runs fine as
/// `<bun> <pi/dist/cli.js>`; vn honors VOICENOTE_PI_CLI by invoking pi that way
/// directly — no wrapper script, no shell, identical on macOS and Windows.
fn engine_env(app: &AppHandle) -> Vec<(String, String)> {
    if cfg!(debug_assertions) {
        return vec![];
    }
    let mut env = Vec::new();
    // bun + ffprobe are externalBin sidecars next to the app binary; pi is a data resource.
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let res_dir = app.path().resource_dir().ok();
    if let (Some(exe_dir), Some(res_dir)) = (exe_dir, res_dir) {
        let bun = exe_dir.join(plat::BUN);
        let pi_cli = res_dir.join("resources/pi/dist/cli.js");
        if let (true, true, Some(b), Some(c)) =
            (bun.exists(), pi_cli.exists(), bun.to_str(), pi_cli.to_str())
        {
            env.push(("VOICENOTE_PI_BIN".to_string(), b.to_string()));
            env.push(("VOICENOTE_PI_CLI".to_string(), c.to_string()));
        }
        let ffprobe = exe_dir.join(plat::FFPROBE);
        if let (true, Some(p)) = (ffprobe.exists(), ffprobe.to_str()) {
            env.push(("VOICENOTE_FFPROBE_BIN".to_string(), p.to_string()));
        }
    }
    env
}

fn apply_engine_env(cmd: &mut Command, app: &AppHandle) {
    for (k, v) in engine_env(app) {
        cmd.env(k, v);
    }
}

/// Resolve how to invoke the voicenote engine.
///
/// - Debug (dev): run the local TypeScript source via `bun`, located relative
///   to this crate so it never hardcodes a machine-specific path. The globally
///   installed `vn` may be an older published build without `vn login`.
/// - Release (bundled): use the `vn` sidecar next to the app executable.
fn vn_command() -> (String, Vec<String>) {
    if cfg!(debug_assertions) {
        let manifest = env!("CARGO_MANIFEST_DIR"); // .../app/src-tauri
        let cli = format!("{manifest}/../../src/cli.ts");
        ("bun".to_string(), vec![cli])
    } else {
        // Tauri places externalBin next to the app executable (Contents/MacOS/vn).
        let sidecar = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(plat::VN)))
            .and_then(|p| p.to_str().map(String::from))
            .unwrap_or_else(|| plat::VN.to_string());
        (sidecar, vec![])
    }
}

// ── Persistent engine: one long-lived `vn serve` the GUI talks to over stdio ──
//
// Instead of spawning `vn` per call (Bun cold start + Windows AV scan + console
// flash every time), we keep ONE `vn serve` process. Requests are correlated by
// id; the reader thread resolves responses and forwards engine events
// (login-event) to the webview.

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

struct Engine {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    child: Mutex<Child>,
    /// Set when a request times out: the process is alive but not answering.
    /// `engine()` treats it as dead (kill + respawn) — a wedged engine must
    /// have the same recovery path as a crashed one, not just error surfacing.
    ///
    /// Accepted tradeoff: ONE slow method condemns the whole shared engine,
    /// killing everything in flight on it (including a mid-OAuth login — the
    /// teardown synthetic `closed` unlocks the UI, the login itself is lost).
    /// serve handles requests concurrently and every legitimate call finishes
    /// well under 60s, so a timeout is strong evidence the process is stuck;
    /// a rare false positive costs one respawn + one retried login, versus a
    /// permanently wedged engine costing everything.
    wedged: AtomicBool,
    /// True while a login started on THIS engine has not yet emitted `closed`.
    /// Lets the reader-thread teardown synthesize a `closed` only when one is
    /// actually owed — an unconditional synthetic would misfire on a login
    /// running on a NEWER engine (wedge recovery kills the old one mid-flight).
    login_active: Arc<AtomicBool>,
}

#[derive(Default)]
struct EngineState(Mutex<Option<Arc<Engine>>>);

fn start_engine(app: &AppHandle) -> Result<Arc<Engine>, String> {
    let (program, mut args) = vn_command();
    args.push("serve".to_string());
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    apply_engine_env(&mut cmd, app);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW (belt-and-suspenders)
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `{program} serve`: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin handle")?;
    let stdout = child.stdout.take().ok_or("no stdout handle")?;

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = pending.clone();
    let login_active = Arc::new(AtomicBool::new(false));
    let login_active_reader = login_active.clone();
    let app_reader = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(t) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match v.get("type").and_then(|x| x.as_str()) {
                Some("res") => {
                    if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
                        if let Some(tx) = pending_reader.lock().unwrap().remove(&id) {
                            let r = if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
                                Err(err.to_string())
                            } else {
                                Ok(v.get("result").cloned().unwrap_or(Value::Null))
                            };
                            let _ = tx.send(r);
                        }
                    }
                }
                Some("event") => {
                    let event = v
                        .get("event")
                        .and_then(|x| x.as_str())
                        .unwrap_or("engine-event")
                        .to_string();
                    let payload = v.get("payload").cloned().unwrap_or(Value::Null);
                    // A real `closed` settles the login; no synthetic one is owed.
                    if event == "login-event"
                        && payload.get("event").and_then(|x| x.as_str()) == Some("closed")
                    {
                        login_active_reader.store(false, Ordering::SeqCst);
                    }
                    let _ = app_reader.emit(&event, payload);
                }
                _ => {}
            }
        }
        // stdout closed (serve exited): fail any in-flight requests so callers unblock.
        for (_, tx) in pending_reader.lock().unwrap().drain() {
            let _ = tx.send(Err("engine process exited".to_string()));
        }
        // A login rides on events (its request is acked immediately), so if
        // THIS engine dies mid-OAuth its `closed` never arrives and the login
        // button would stay locked forever. Synthesize one — but only when a
        // login on this engine is actually unresolved: an unconditional
        // synthetic would clobber a login running on a newer engine.
        if login_active_reader.swap(false, Ordering::SeqCst) {
            // `reason` distinguishes this system-side abort from a normal
            // serve-driven close, so the UI can tell the user what happened
            // (engine died, login aborted, retry) instead of a generic exit.
            let _ = app_reader.emit(
                "login-event",
                serde_json::json!({ "event": "closed", "code": Value::Null, "reason": "engine-exited" }),
            );
        }
    });

    Ok(Arc::new(Engine {
        stdin: Mutex::new(stdin),
        pending,
        next_id: AtomicU64::new(1),
        child: Mutex::new(child),
        wedged: AtomicBool::new(false),
        login_active,
    }))
}

/// Get the running engine, (re)spawning it if absent, dead, or wedged.
fn engine(app: &AppHandle, state: &EngineState) -> Result<Arc<Engine>, String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(e) = guard.as_ref() {
        let wedged = e.wedged.load(Ordering::SeqCst);
        let alive = e
            .child
            .lock()
            .unwrap()
            .try_wait()
            .map(|s| s.is_none())
            .unwrap_or(false);
        if alive && !wedged {
            return Ok(e.clone());
        }
        if alive && wedged {
            // Kill the unresponsive process; closing its stdout makes the
            // reader thread drain pending requests so blocked callers unblock.
            let mut child = e.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait(); // reap; kill() already terminated it
        }
    }
    let e = start_engine(app)?;
    *guard = Some(e.clone());
    Ok(e)
}

fn request(engine: &Engine, method: &str, params: Value) -> Result<Value, String> {
    let id = engine.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    engine.pending.lock().unwrap().insert(id, tx);
    let msg = serde_json::json!({ "type": "req", "id": id, "method": method, "params": params });
    {
        let mut stdin = engine.stdin.lock().unwrap();
        // On write failure, remove our pending entry before returning — same
        // invariant as the timeout branch below: whoever fails a request cleans
        // up its own pending slot instead of leaving it for reader teardown.
        let write_res = writeln!(stdin, "{msg}").and_then(|_| stdin.flush());
        if let Err(e) = write_res {
            engine.pending.lock().unwrap().remove(&id);
            return Err(format!("write to engine: {e}"));
        }
    }
    // Bounded wait: a wedged-but-alive engine (process up, not answering) must
    // surface as an error instead of hanging the request forever — the
    // frontend's failure escalation counts on invoke() eventually rejecting.
    // Callers reach this via `engine_request` (spawn_blocking), so the wait
    // occupies the dedicated blocking pool, not the async runtime's core
    // workers — concurrent stuck requests can't starve unrelated commands. 60s
    // covers the slowest legitimate calls (doctor spawns `pi --version` with a
    // 15s timeout; ensure_agent runs several launchctl/schtasks steps; login is
    // acked immediately by serve, its progress rides on events). On timeout,
    // drop the pending entry so the
    // reader thread ignores a late response instead of leaking the sender, and
    // mark the engine wedged so the NEXT call kills and respawns it (recovery,
    // not just surfacing).
    use std::sync::mpsc::RecvTimeoutError;
    match rx.recv_timeout(std::time::Duration::from_secs(60)) {
        Ok(r) => r,
        Err(RecvTimeoutError::Disconnected) => Err("engine closed".to_string()),
        Err(RecvTimeoutError::Timeout) => {
            engine.pending.lock().unwrap().remove(&id);
            engine.wedged.store(true, Ordering::SeqCst);
            Err(format!("engine request `{method}` timed out (60s)"))
        }
    }
}

/// Async wrapper every command goes through: acquiring the engine (which may
/// kill + respawn a wedged process — `Command::spawn` can be slow under
/// Windows AV scans) AND the bounded-blocking `request()` both run on the
/// blocking pool, so async runtime core workers stay free for other commands.
async fn engine_request(app: AppHandle, method: &'static str, params: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<EngineState>();
        let e = engine(&app, &state)?;
        request(&e, method, params)
    })
    .await
    .map_err(|err| format!("engine task failed: {err}"))?
}

/// Read current file-based config (env map + identity) for the wizard prefill.
// Commands are `async fn` (off the main thread) and delegate ALL potentially
// blocking engine work (acquire/respawn + round-trip) to `engine_request`.
#[tauri::command]
async fn config_get(app: AppHandle) -> Result<Value, String> {
    engine_request(app, "config.get", Value::Null).await
}

/// Persist config from the wizard. `payload` is `{ env: {..}, self: {name, aliases} }`.
#[tauri::command]
async fn config_set(app: AppHandle, payload: Value) -> Result<(), String> {
    engine_request(app, "config.set", payload).await.map(|_| ())
}

/// Structured health/config snapshot for the status dashboard.
#[tauri::command]
async fn doctor_status(app: AppHandle) -> Result<Value, String> {
    engine_request(app, "doctor", Value::Null).await
}

/// Processing status of recent recordings: live job + done + failed.
#[tauri::command]
async fn recent_jobs(app: AppHandle) -> Result<Value, String> {
    engine_request(app, "jobs", serde_json::json!({ "limit": 40 })).await
}

/// Ensure the autonomous background scheduler (mac LaunchAgent / Windows Task
/// Scheduler) is installed and points at THIS app's bundled engine. The
/// staleness check + (re)install now live in `vn` (ensureScheduler); this is a
/// thin forward. `force` reinstalls even if already current.
#[tauri::command]
async fn ensure_agent(app: AppHandle, force: bool) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return Ok("dev: scheduler not managed".to_string());
    }
    engine_request(app, "ensure_agent", serde_json::json!({ "force": force }))
        .await
        .map(|_| "ok".to_string())
}

/// Kick off the ChatGPT (Codex OAuth) login. serve acks the request
/// immediately; auth_url / success / error / closed then stream back to the
/// webview as `login-event` via the engine reader thread. Failure channels:
/// a startup failure (ack never arrives) surfaces as this command's Err —
/// handled by startLogin's invoke catch — an engine death after the ack
/// (mid-OAuth) is covered by the reader teardown's synthetic `closed`, and an
/// abandoned browser flow is bounded by serve's own 10-minute OAuth timeout
/// (error + closed events). If the
/// engine dies between `login_active.store(true)` and the ack, BOTH fire
/// (teardown usually swaps the flag before our `store(false)` runs); that is
/// fine — the frontend is idempotent under either arrival order (invoke catch
/// shows the error, `loginRunning` guard no-ops the extra closed). Don't
/// "fix" the double-fire by moving `store(true)` after the ack: dying right
/// after the ack would then leave no synthetic closed and lock the login
/// button forever — strictly worse.
#[tauri::command]
async fn login_chatgpt(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<EngineState>();
        let e = engine(&app, &state)?;
        // Owed a `closed` from here on: reader teardown synthesizes one if
        // this engine dies before serve delivers it. A real closed clears it.
        e.login_active.store(true, Ordering::SeqCst);
        let r = request(&e, "login", Value::Null);
        if r.is_err() {
            // serve never acked, so no closed is owed — the Err below reaches
            // the frontend's invoke catch, which unlocks the login UI.
            e.login_active.store(false, Ordering::SeqCst);
        }
        r.map(|_| ())
    })
    .await
    .map_err(|err| format!("engine task failed: {err}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![
            login_chatgpt,
            config_get,
            config_set,
            doctor_status,
            recent_jobs,
            ensure_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
