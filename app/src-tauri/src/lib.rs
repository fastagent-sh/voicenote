use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

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

/// Env the bundled CLI needs to find its sibling runtimes. Dev resolves pi /
/// ffprobe from PATH; release runs pi as `<bun> <pi/dist/cli.js>` directly.
fn bundled_env(app: &AppHandle) -> Vec<(String, String)> {
    if cfg!(debug_assertions) {
        return vec![];
    }
    let mut env = Vec::new();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
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

/// Resolve how to invoke VoiceNote: source through Bun in dev, bundled sidecar
/// in release. Every GUI operation gets a fresh process, so config and failures
/// cannot leak between unrelated requests.
fn vn_process(app: &AppHandle) -> Command {
    let (program, args) = if cfg!(debug_assertions) {
        let manifest = env!("CARGO_MANIFEST_DIR");
        (
            "bun".to_string(),
            vec![format!("{manifest}/../../src/cli.ts")],
        )
    } else {
        let sidecar = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(plat::VN)))
            .and_then(|p| p.to_str().map(String::from))
            .unwrap_or_else(|| plat::VN.to_string());
        (sidecar, vec![])
    };
    let mut cmd = Command::new(program);
    cmd.args(args);
    for (key, value) in bundled_env(app) {
        cmd.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_for_output(
    mut child: Child,
    input: Option<Vec<u8>>,
    label: &str,
) -> Result<String, String> {
    if let Some(input) = input {
        let write = child
            .stdin
            .as_mut()
            .ok_or_else(|| format!("`vn {label}` has no stdin"))
            .and_then(|stdin| {
                stdin
                    .write_all(&input)
                    .map_err(|e| format!("write to `vn {label}`: {e}"))
            });
        if let Err(e) = write {
            stop_child(&mut child);
            return Err(e);
        }
    }
    drop(child.stdin.take());

    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        stop_child(&mut child);
        return Err(format!("`vn {label}` output was not piped"));
    };
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });

    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                stop_child(&mut child);
                let _ = out.join();
                let _ = err.join();
                return Err(format!("`vn {label}` timed out after 60s"));
            }
            Err(e) => {
                stop_child(&mut child);
                let _ = out.join();
                let _ = err.join();
                return Err(format!("wait for `vn {label}`: {e}"));
            }
        }
    };
    let stdout = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    if status.success() {
        Ok(stdout)
    } else {
        let detail = stderr.trim().to_string();
        Err(if detail.is_empty() {
            format!("`vn {label}` exited with {status}")
        } else {
            format!("`vn {label}` exited with {status}: {detail}")
        })
    }
}

fn run_vn(app: &AppHandle, args: &[&str], input: Option<Vec<u8>>) -> Result<String, String> {
    let label = args.join(" ");
    let mut cmd = vn_process(app);
    cmd.args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `vn {label}`: {e}"))?;
    wait_for_output(child, input, &label)
}

fn parse_json(stdout: &str, label: &str) -> Result<Value, String> {
    serde_json::from_str(stdout.trim()).map_err(|e| format!("invalid JSON from `vn {label}`: {e}"))
}

async fn run_vn_json(app: AppHandle, args: &'static [&'static str]) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stdout = run_vn(&app, args, None)?;
        parse_json(&stdout, &args.join(" "))
    })
    .await
    .map_err(|e| format!("vn task failed: {e}"))?
}

#[tauri::command]
async fn config_get(app: AppHandle) -> Result<Value, String> {
    run_vn_json(app, &["config", "get"]).await
}

#[tauri::command]
async fn config_set(app: AppHandle, payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_vn(
            &app,
            &["config", "set"],
            Some(payload.to_string().into_bytes()),
        )
        .map(|_| ())
    })
    .await
    .map_err(|e| format!("vn task failed: {e}"))?
}

#[tauri::command]
async fn doctor_status(app: AppHandle) -> Result<Value, String> {
    run_vn_json(app, &["doctor", "--json"]).await
}

#[tauri::command]
async fn recent_jobs(app: AppHandle) -> Result<Value, String> {
    run_vn_json(app, &["jobs", "--json", "--limit", "40"]).await
}

#[tauri::command]
async fn trigger_run(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = vn_process(&app);
        cmd.arg("run")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to spawn `vn run`: {e}"))
    })
    .await
    .map_err(|e| format!("vn task failed: {e}"))?
}

#[tauri::command]
async fn ensure_agent(app: AppHandle, force: bool) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return Ok("dev: scheduler not managed".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let args = if force {
            vec!["ensure-launch-agent", "--force"]
        } else {
            vec!["ensure-launch-agent"]
        };
        run_vn(&app, &args, None).map(|_| "ok".to_string())
    })
    .await
    .map_err(|e| format!("vn task failed: {e}"))?
}

fn relay_login(app: AppHandle, mut child: Child) {
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            stop_child(&mut child);
            let _ = app.emit(
                "login-event",
                serde_json::json!({ "event": "error", "message": "login process has no stdout" }),
            );
            let _ = app.emit(
                "login-event",
                serde_json::json!({ "event": "closed", "code": 1 }),
            );
            return;
        }
    };
    let reader_app = app.clone();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                let _ = reader_app.emit("login-event", value);
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(10 * 60);
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(1),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(250)),
            Ok(None) => {
                let _ = app.emit("login-event", serde_json::json!({
                    "event": "error",
                    "message": "Login timed out: authorization was not completed within 10 minutes"
                }));
                stop_child(&mut child);
                break 1;
            }
            Err(e) => {
                stop_child(&mut child);
                let _ = app.emit("login-event", serde_json::json!({ "event": "error", "message": format!("login process failed: {e}") }));
                break 1;
            }
        }
    };
    let _ = reader.join();
    let _ = app.emit(
        "login-event",
        serde_json::json!({ "event": "closed", "code": code }),
    );
}

#[tauri::command]
async fn login_chatgpt(app: AppHandle) -> Result<(), String> {
    let child = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            let mut cmd = vn_process(&app);
            cmd.args(["login", "--json"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            cmd.spawn()
                .map_err(|e| format!("failed to spawn `vn login`: {e}"))
        }
    })
    .await
    .map_err(|e| format!("vn task failed: {e}"))??;
    tauri::async_runtime::spawn_blocking(move || relay_login(app, child));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_json;

    #[test]
    fn cli_json_must_not_be_mixed_with_logs() {
        assert!(parse_json("{\"ok\":true}", "test").is_ok());
        assert!(parse_json("log\n{\"ok\":true}", "test").is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            login_chatgpt,
            config_get,
            config_set,
            doctor_status,
            recent_jobs,
            trigger_run,
            ensure_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
