import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { JobsRefreshState } from "./jobsState";
import { t, applyStaticI18n, savedLang, setLang } from "./i18n";

// ── Settings schema (flat, grouped; lives inline in the dashboard) ───────────
type Field = { key: string; label: string; placeholder?: string; default?: string; secret?: boolean; required?: boolean; options?: { value: string; label: string }[] };
type Group = { label: string; fields: Field[] };

const GROUPS: Group[] = [
  { label: "Identity", fields: [
    { key: "self_name", label: "Your name", placeholder: "Jane Doe" },
    { key: "self_aliases", label: "Aliases (comma-separated, optional)", placeholder: "jane, JD" },
  ]},
  { label: "Recording & output", fields: [
    { key: "VOICENOTE_RECORD_DIR", label: "Recording directory", placeholder: "Empty = auto (VTR6500 on macOS); on Windows use a drive path like E:\\RECORD" },
    { key: "VOICENOTE_WORKSPACE", label: "Notes output directory", default: "$HOME/Documents/meetings" },
    { key: "VOICENOTE_MAX_AGE_HOURS", label: "Only process recordings from the last N hours (0 = no limit)", default: "48" },
  ]},
  { label: "Transcription (Volcano / Doubao)", fields: [
    { key: "VOLCANO_ASR_KEY", label: "ASR Key", secret: true, required: true },
    { key: "VOLCANO_TOS_BUCKET", label: "TOS Bucket", required: true },
    { key: "VOLCANO_TOS_ACCESS_KEY", label: "TOS Access Key", secret: true, required: true },
    { key: "VOLCANO_TOS_SECRET_KEY", label: "TOS Secret Key", secret: true, required: true },
  ]},
  // Credentials always come from pi; only the model can be pinned here.
  { label: "Notes generation (credentials come from pi)", fields: [
    { key: "VOICENOTE_PI_MODEL", label: "Model", placeholder: "Empty = pi's own default; or e.g. openai-codex/gpt-5.6-sol" },
    { key: "DEEPSEEK_API_KEY", label: "DeepSeek API Key", secret: true, placeholder: "Leave empty to use credentials from pi or the environment" },
    { key: "OPENAI_API_KEY", label: "OpenAI API Key", secret: true, placeholder: "Leave empty to use credentials from pi or the environment" },
  ]},
  { label: "Network proxy (empty = system proxy)", fields: [
    { key: "LOCAL_PROXY_HOST", label: "Proxy host (optional)", placeholder: "Empty = follow system proxy" },
    { key: "LOCAL_PROXY_PORT", label: "Proxy port (optional)", placeholder: "Empty = follow system proxy" },
  ]},
  { label: "Advanced (defaults are usually fine)", fields: [
    { key: "VOLCANO_ASR_RESOURCE_ID", label: "ASR Resource ID", default: "volc.seedasr.auc" },
    { key: "VOLCANO_TOS_REGION", label: "TOS Region", default: "cn-guangzhou" },
    { key: "VOLCANO_TOS_ENDPOINT", label: "TOS Endpoint", default: "tos-s3-cn-guangzhou.volces.com" },
  ]},
];
const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);
const ENV_KEYS = ALL_FIELDS.map((f) => f.key).filter((k) => !k.startsWith("self_"));

// ── Types ────────────────────────────────────────────────────────────────────
type Status = {
  workspace: string;
  recorder: { dir: string; exists: boolean };
  volcano: { configured: true; tos: { bucket: string } } | { configured: false };
  pi: { available: boolean };
  summary: { model: string | null };
  proxy: { url: string | null };
  identity: { self: string | null };
  deps: { ffprobe: boolean };
  agent: { installed: boolean; logTail: string[] };
};
type Job = {
  status: "running" | "queued" | "done" | "notes_failed" | "error" | "gave_up" | "filtered";
  name: string;
  title: string | null;
  step?: string | null;
  time?: string | null;
  detail?: string | null;
  notes: string | null;
};

let status: Status | null = null;
let loginRunning = false;
let loginSucceeded = false;
let settingsBuilt = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function inputEl(key: string) { return document.getElementById(`f_${key}`) as HTMLInputElement | HTMLSelectElement | null; }
function setStatus(el: HTMLElement, text: string, kind: "" | "ok" | "err" | "wait" = "") { el.textContent = text; el.className = `status ${kind}`; }
function showScreen(which: "dash" | "settings") { $("dash").hidden = which !== "dash"; $("settings").hidden = which !== "settings"; }

// ── Agent pill ───────────────────────────────────────────────────────────────
function renderAgentPill(a: Status["agent"]) {
  const pill = $("agent-pill");
  let text = t("Agent running"), tone = "ok";
  const last = (a.logTail ?? []).slice(-1)[0] ?? "";
  if (!a.installed) { text = t("Agent not enabled"); tone = "err"; }
  else if (/ERROR|failed|失败/i.test(last)) { text = t("Agent error · check logs"); tone = "err"; }
  else if (/Idle|no new recordings/i.test(last)) { text = t("Idle · plug in the recorder to process"); tone = "ok"; }
  else if (/transcrib|Volcano|Step 2|转写/i.test(last)) { text = t("Transcribing…"); tone = "wait"; }
  else if (/generate|notes|Step 3|纪要/i.test(last)) { text = t("Generating notes…"); tone = "wait"; }
  else if (/Completed|✓|Queue|processing/i.test(last)) { text = t("Processing…"); tone = "wait"; }
  pill.textContent = text; pill.className = `agent-pill ${tone}`;
}

// ── Status rows ──────────────────────────────────────────────────────────────
function statusRow(label: string, value: string, tone: "ok" | "warn" | "err" | "muted") {
  const row = document.createElement("div");
  row.className = "srow";
  const dot = document.createElement("span"); dot.className = `dot ${tone}`;
  const lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = label;
  const val = document.createElement("span"); val.className = `val ${tone === "err" ? "err" : ""}`; val.textContent = value;
  row.append(dot, lbl, val);
  return row;
}

function renderStatus() {
  const box = $("status-rows");
  box.innerHTML = "";
  if (!status) { box.appendChild(statusRow(t("Status"), t("Checking…"), "muted")); return; }
  const s = status;
  box.appendChild(statusRow(t("Notes generation"), s.pi.available ? t("pi ready") : t("pi not available"), s.pi.available ? "ok" : "err"));
  box.appendChild(statusRow(t("Summary model"), s.summary.model ?? t("pi's own default"), "muted"));
  box.appendChild(statusRow(t("Transcription"), s.volcano.configured ? t("Configured · {0}", s.volcano.tos.bucket) : t("Not configured"), s.volcano.configured ? "ok" : "err"));
  box.appendChild(statusRow(t("Proxy"), s.proxy.url ?? t("Not set"), s.proxy.url ? "ok" : "warn"));
  box.appendChild(statusRow(t("Recorder"), s.recorder.exists ? t("Connected") : t("Not detected"), s.recorder.exists ? "ok" : "muted"));
  box.appendChild(statusRow(t("Audio tools"), s.deps.ffprobe ? t("Ready") : t("Missing"), s.deps.ffprobe ? "ok" : "err"));
}

// ── Jobs (processing status of each recording) ───────────────────────────────
const JOB_META: Record<Job["status"], { label: string; tone: string }> = {
  running: { label: "Running", tone: "wait" },
  queued: { label: "Queued", tone: "" },
  done: { label: "Done", tone: "ok" },
  notes_failed: { label: "Notes retry pending", tone: "err" },
  error: { label: "Failed — will retry", tone: "err" },
  // Retries are spent; `detail` carries the count and the `vn forget` way out.
  gave_up: { label: "Gave up", tone: "err" },
  filtered: { label: "Filtered out", tone: "" },
};

function renderJobs(jobs: Job[], total = jobs.length, recorderPresent = true, queuedTotal = 0) {
  const list = $("notes-list");
  list.innerHTML = "";
  if (!jobs.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.innerHTML = `<div class="e-icon">🎙️</div>`;
    const p = document.createElement("p");
    p.textContent = t("No recordings yet. Plug in the recorder and the agent will transcribe and generate notes automatically; progress shows up here.");
    e.appendChild(p);
    list.appendChild(e);
    return;
  }
  for (const j of jobs) {
    const meta = JOB_META[j.status] ? { label: t(JOB_META[j.status].label), tone: JOB_META[j.status].tone } : { label: j.status, tone: "" };
    // notes_failed's stub note links the saved transcript + retry command —
    // openable so the user can actually reach them.
    const openable = (j.status === "done" || j.status === "notes_failed" || j.status === "gave_up") && !!j.notes;
    const card = document.createElement("button");
    card.className = "job-card";
    card.disabled = !openable;

    const head = document.createElement("div"); head.className = "job-head";
    const badge = document.createElement("span"); badge.className = `jbadge ${meta.tone}`;
    badge.textContent = j.status === "running" && j.step ? `${meta.label} · ${j.step}` : meta.label;
    head.appendChild(badge);
    if (openable) { const open = document.createElement("span"); open.className = "job-open"; open.textContent = t("Open ↗"); head.appendChild(open); }

    const title = document.createElement("div"); title.className = "job-title";
    title.textContent = j.title || j.name;
    card.append(head, title);

    if (j.time) { const tm = document.createElement("div"); tm.className = "job-time"; tm.textContent = j.time; card.appendChild(tm); }
    if (j.detail) {
      const r = document.createElement("div"); r.className = "job-reason"; r.textContent = j.detail; card.appendChild(r);
    }
    if (openable) card.addEventListener("click", () => openPath(j.notes!));
    list.appendChild(card);
  }
  // The list is capped; say so rather than letting a long backlog look short.
  if (total > jobs.length) {
    const more = document.createElement("div");
    more.className = "job-time";
    more.textContent = t("… {0} more", total - jobs.length);
    list.appendChild(more);
  }
  // A queue that can't drain because the recorder is unplugged looks identical
  // to a queue that's about to run. Say which one it is.
  if (!recorderPresent) {
    const note = document.createElement("div");
    note.className = "job-time";
    note.textContent = queuedTotal
      ? t("Recorder not connected — {0} recording(s) waiting for it.", queuedTotal)
      : t("Recorder not connected.");
    list.appendChild(note);
  }
}

function renderError(containerId: string, msg: string) {
  const box = $(containerId);
  box.innerHTML = "";
  const p = document.createElement("p");
  p.className = "load-error";
  p.textContent = msg;
  box.appendChild(p);
}

// Refresh decisions (latest-wins rendering, cross-request explicit feedback,
// failure escalation) live in a pure, tested state machine — see jobsState.ts
// for the invariants and jobsState.test.ts for their proofs.
const jobsState = new JobsRefreshState();

async function refreshJobs(explicit = false) {
  const seq = jobsState.begin(explicit);
  // The try covers ONLY the engine round-trip: this catch feeds the state
  // machine's failure accounting, and a renderJobs/DOM bug recorded as an
  // engine failure would both corrupt that accounting (success then failure
  // for one request) and misreport a frontend bug as an engine failure.
  let r: { items: Job[]; total?: number; queued_total?: number; recorder_present?: boolean };
  try {
    r = (await invoke("recent_jobs")) as { items: Job[]; total?: number; queued_total?: number; recorder_present?: boolean };
  } catch (e) {
    if (jobsState.failure() === "error") renderError("notes-list", t("Failed to read processing status: {0}", String(e)));
    else console.error("refreshJobs (background)", e); // poll/boot/post-save flow: keep last-good list
    return;
  }
  const items = r.items ?? [];
  const total = r.total ?? items.length;
  const present = r.recorder_present ?? true;
  const queuedTotal = r.queued_total ?? 0;
  if (jobsState.success(seq, JSON.stringify({ items, total, present, queuedTotal })) === "render") renderJobs(items, total, present, queuedTotal);
}

// `explicit` = the user pressed the refresh button (needs failure feedback);
// all other callers (boot, post-login, post-save) are automatic flows and keep
// the last-good jobs list on transient errors, same as the background poll.
async function refreshStatus(explicit = false) {
  try {
    status = (await invoke("doctor_status")) as Status;
  } catch (e) {
    status = null;
    const pill = $("agent-pill");
    pill.textContent = t("Status check failed");
    pill.className = "agent-pill err";
    renderError("status-rows", t("Failed to read status: {0}", String(e)));
    // Still attempt the jobs refresh: an explicit refresh promised feedback,
    // and jobs may succeed (or surface its own error) even when doctor fails.
    void refreshJobs(explicit);
    return;
  }
  renderAgentPill(status.agent);
  renderStatus();
  void refreshJobs(explicit);
}

// Manual "Sync": re-detect the recorder (doctor) and, if present, kick off a
// processing run. Gives the explicit feedback the passive ↻ refresh doesn't —
// device-not-found is the common "plugged in but not recognized, no GUI feedback" case, so we say so
// instead of silently doing nothing.
async function syncNow() {
  const btn = $("sync-btn") as HTMLButtonElement;
  // Own sync feedback slot — NOT agent-pill: the pill is the background agent's
  // live state (renderAgentPill from logTail) and only refreshes on
  // refreshStatus, so writing action feedback there would sit stale over the
  // agent's real status until the next manual refresh.
  const st = $("sync-status");
  btn.disabled = true;
  setStatus(st, t("Syncing…"), "wait");
  try {
    // refreshStatus swallows doctor failures (sets status=null) instead of
    // throwing — so branch on `status`, don't rely on the catch below.
    await refreshStatus(true); // re-detect device (updates status rows) + refresh jobs
    if (!status) { setStatus(st, t("Failed to read status, retry later"), "err"); return; }
    if (!status.recorder.exists) { setStatus(st, t("Recorder not detected · re-plug it and press Sync again"), "err"); return; }
    await invoke("trigger_run"); // acks immediately; run proceeds in background
    // Neutral wording: a run may be deduped by acquireRunLock (a background
    // tick already holds it), so don't promise "new recordings will appear" — point at the
    // list, which reflects whichever run is active.
    setStatus(st, t("Sync triggered · progress shows in the list below"), "wait");
  } catch (e) {
    setStatus(st, t("Sync failed: {0}", String(e)), "err");
  } finally {
    btn.disabled = false;
  }
}

// ── Settings (inline, built once; values loaded from config) ─────────────────
function makeInput(f: Field): HTMLElement {
  const wrap = document.createElement("label"); wrap.className = "field";
  const span = document.createElement("span"); span.textContent = t(f.label);
  if (f.required) { const s = document.createElement("em"); s.textContent = " *"; s.className = "req"; span.appendChild(s); }
  const el = f.options ? document.createElement("select") : document.createElement("input");
  el.id = `f_${f.key}`;
  if (el instanceof HTMLSelectElement) {
    for (const option of f.options!) el.add(new Option(t(option.label), option.value));
  } else {
    el.type = f.secret ? "password" : "text";
    if (f.placeholder) el.placeholder = t(f.placeholder);
  }
  el.required = !!f.required;
  wrap.append(span, el);
  return wrap;
}

function buildSettings() {
  if (settingsBuilt) return;
  const root = $("fields");
  for (const g of GROUPS) {
    const sec = document.createElement("section");
    sec.className = "settings-group";
    const lbl = document.createElement("div"); lbl.className = "group-label"; lbl.textContent = t(g.label);
    sec.appendChild(lbl);
    for (const f of g.fields) sec.appendChild(makeInput(f));
    root.appendChild(sec);
  }
  settingsBuilt = true;
}

async function openSettings() { buildSettings(); showScreen("settings"); setStatus($("settings-status"), ""); void showAppVersion(); await loadConfig(); }

// ── Software update (Tauri updater; static latest.json on GitHub Releases) ────
// `check()` reads the pubkey-verified latest.json from the updater endpoint;
// the returned Update is stashed so the install button can download+install the
// exact artifact that was just verified, then relaunch into it.
let pendingUpdate: Update | null = null;

async function showAppVersion() {
  try { $("update-version").textContent = t("Current version v{0}", await getVersion()); } catch (e) { console.error("getVersion", e); }
}

async function checkUpdate() {
  const btn = $("check-update-btn") as HTMLButtonElement;
  const st = $("update-status");
  const installBtn = $("install-update-btn") as HTMLButtonElement;
  btn.disabled = true; installBtn.hidden = true; pendingUpdate = null;
  setStatus(st, t("Checking…"), "wait");
  try {
    // Route the update check (and the download, which reuses these options)
    // through the configured/system proxy — github.com is often unreachable
    // directly from CN networks. If status never loaded (doctor failed), fetch
    // it now rather than silently degrading to a direct connection.
    if (!status) await refreshStatus();
    const update = await check(status?.proxy.url ? { proxy: status.proxy.url } : undefined);
    if (!update) { setStatus(st, t("Already up to date"), "ok"); return; }
    pendingUpdate = update;
    setStatus(st, t("New version available: v{0}", update.version), "");
    installBtn.hidden = false;
  } catch (e) {
    setStatus(st, t("Update check failed: {0}", String(e)), "err");
  } finally {
    btn.disabled = false;
  }
}

async function installUpdate() {
  if (!pendingUpdate) return;
  const st = $("update-status");
  const installBtn = $("install-update-btn") as HTMLButtonElement;
  const checkBtn = $("check-update-btn") as HTMLButtonElement;
  installBtn.disabled = true; checkBtn.disabled = true;
  let total = 0, got = 0;
  try {
    // downloadAndInstall verifies the signature against the configured pubkey
    // before installing; a tampered artifact rejects here. On Windows Tauri
    // quits the app to run the installer; on macOS we relaunch explicitly.
    await pendingUpdate.downloadAndInstall((e) => {
      switch (e.event) {
        case "Started": total = e.data.contentLength ?? 0; setStatus(st, t("Starting download…"), "wait"); break;
        case "Progress": got += e.data.chunkLength; setStatus(st, total ? t("Downloading {0}%", Math.round((got / total) * 100)) : t("Downloading ({0} bytes)", got), "wait"); break;
        case "Finished": setStatus(st, t("Downloaded, installing…"), "wait"); break;
      }
    });
    setStatus(st, t("Installed, restarting…"), "ok");
    await relaunch();
  } catch (e) {
    setStatus(st, t("Update failed: {0}", String(e)), "err");
    installBtn.disabled = false; checkBtn.disabled = false;
  }
}

// Saving submits EVERY field, and empty fields are persisted as null (= delete
// key). So a form that failed to prefill from the current config must never be
// saved — it would silently wipe existing secrets. Saving stays disabled until
// config_get succeeds.
let settingsLoaded = false;

async function loadConfig() {
  buildSettings();
  let cfg: { env?: Record<string, string>; self?: { name?: string | null; aliases?: string[] } };
  try {
    cfg = (await invoke("config_get")) as typeof cfg;
  } catch (e) {
    settingsLoaded = false;
    ($("save-btn") as HTMLButtonElement).disabled = true;
    setStatus($("settings-status"), t("Failed to read current config: {0} — saving is disabled to avoid overwriting existing config; go back and reopen Settings", String(e)), "err");
    return;
  }
  settingsLoaded = true;
  ($("save-btn") as HTMLButtonElement).disabled = false;
  for (const f of ALL_FIELDS) {
    if (f.key.startsWith("self_")) continue;
    const el = inputEl(f.key);
    if (el) {
      const value = cfg.env?.[f.key] ?? f.default ?? "";
      if (el instanceof HTMLSelectElement && !Array.from(el.options).some(o => o.value === value)) el.add(new Option(value, value));
      el.value = value;
    }
  }
  const name = inputEl("self_name"); if (name) name.value = cfg.self?.name ?? "";
  const al = inputEl("self_aliases"); if (al) al.value = (cfg.self?.aliases ?? []).join(", ");
}

async function ensureAgent(force = false) { try { await invoke("ensure_agent", { force }); } catch (e) { console.error("ensure_agent", e); } }

async function saveSettings(e: Event) {
  e.preventDefault();
  if (!settingsLoaded) { setStatus($("settings-status"), t("Config was not loaded successfully; saving is disabled (it would wipe existing config). Go back and reopen Settings"), "err"); return; }
  for (const f of ALL_FIELDS) { if (f.required && !(inputEl(f.key)?.value ?? "").trim()) { setStatus($("settings-status"), t('Please fill in "{0}"', t(f.label)), "err"); return; } }
  const env: Record<string, string | null> = {};
  for (const key of ENV_KEYS) { const v = (inputEl(key)?.value ?? "").trim(); env[key] = v === "" ? null : v; }
  const aliases = (inputEl("self_aliases")?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const self = { name: (inputEl("self_name")?.value ?? "").trim() || null, aliases };
  const btn = $("save-btn") as HTMLButtonElement;
  btn.disabled = true;
  setStatus($("settings-status"), t("Saving…"), "wait");
  try {
    await invoke("config_set", { payload: { env, self } });
    await ensureAgent(true);
    await refreshStatus();
    showScreen("dash");
  } catch (err) {
    setStatus($("settings-status"), t("Save failed: {0}", String(err)), "err");
  } finally {
    btn.disabled = false;
  }
}

// ── Login (inline) ───────────────────────────────────────────────────────────
type LoginEvent =
  | { event: "auth_url"; url: string }
  | { event: "device_code"; userCode: string; verificationUri: string }
  | { event: "success"; provider: string }
  | { event: "error"; message: string }
  | { event: "closed"; code: number | null; reason?: string };

function onLoginEvent(e: LoginEvent) {
  // No login running → every login-event is stale or synthetic (an abandoned
  // flow's stragglers, or the engine-teardown closed) — none of them may touch
  // the UI. This single gate keeps all branches consistent; `error` flips
  // loginRunning off itself, which also makes its follow-up `closed` a no-op.
  if (!loginRunning) return;
  const st = $("login-status");
  switch (e.event) {
    case "auth_url":
      setStatus(st, t("Browser opened; this completes automatically after you authorize…"), "wait");
      ($("auth-link") as HTMLAnchorElement).dataset.url = e.url; $("auth-link-wrap").hidden = false; break;
    case "device_code":
      setStatus(st, t("Enter {0} at {1}", e.userCode, e.verificationUri), "wait"); break;
    case "success":
      loginSucceeded = true; setStatus(st, t("✓ Signed in"), "ok"); $("auth-link-wrap").hidden = true; break;
    case "error":
      // Terminal: end the login here so the follow-up `closed` hits the guard
      // below and cannot overwrite this diagnostic with a generic "login exited".
      loginRunning = false;
      setStatus(st, t("Sign-in failed: {0}", e.message), "err"); ($("login-btn") as HTMLButtonElement).disabled = false; break;
    case "closed":
      loginRunning = false; ($("login-btn") as HTMLButtonElement).disabled = false;
      if (loginSucceeded) ensureAgent(true).then(() => refreshStatus());
      else if (e.reason === "engine-exited") setStatus(st, t("Engine exited unexpectedly; sign-in aborted, please retry"), "err");
      else if (e.code !== 0) setStatus(st, t("Sign-in exited (code={0})", e.code ?? "?"), "err");
      break;
  }
}

function startLogin() {
  if (loginRunning) return;
  loginRunning = true; loginSucceeded = false;
  $("auth-link-wrap").hidden = true; ($("login-btn") as HTMLButtonElement).disabled = true;
  setStatus($("login-status"), t("Starting sign-in…"), "wait");
  invoke("login_chatgpt").catch((err) => { loginRunning = false; setStatus($("login-status"), t("Failed to start: {0}", String(err)), "err"); ($("login-btn") as HTMLButtonElement).disabled = false; });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  applyStaticI18n();
  listen<LoginEvent>("login-event", (e) => onLoginEvent(e.payload));

  $("refresh-btn").addEventListener("click", () => void refreshStatus(true));
  $("sync-btn").addEventListener("click", () => void syncNow());
  $("settings-btn").addEventListener("click", () => void openSettings());
  $("check-update-btn").addEventListener("click", () => void checkUpdate());
  $("install-update-btn").addEventListener("click", () => void installUpdate());
  $("settings-back").addEventListener("click", (e) => { e.preventDefault(); showScreen("dash"); });
  $("open-ws").addEventListener("click", (e) => { e.preventDefault(); if (status?.workspace) openPath(status.workspace); });
  $("settings-form").addEventListener("submit", saveSettings);
  $("login-btn").addEventListener("click", startLogin);
  const langSel = $("lang-select") as HTMLSelectElement;
  langSel.value = savedLang;
  langSel.addEventListener("change", () => setLang(langSel.value));
  $("auth-link").addEventListener("click", (e) => { e.preventDefault(); const u = ($("auth-link") as HTMLAnchorElement).dataset.url; if (u) openUrl(u); });

  // The background agent retries/processes recordings on its own 60s tick;
  // poll the jobs list so failed→done transitions show up without a manual refresh.
  // Chained (next tick scheduled only after the previous settles) so at most
  // one poll is in flight — a slow/wedged engine gets one pending request, not
  // a new one stacking every 10s. Deliberately NOT polled: the agent pill /
  // status rows. They come from doctor_status, which spawns sidecars
  // (`pi --version`, ffprobe) on every call — too heavy for a 10s tick — so
  // the pill can lag the job list until the next manual refresh.
  // Reschedule in finally so the chain survives any rejection out of
  // refreshJobs — a broken link would silently stop all polling.
  const pollJobs = () => setTimeout(() => { refreshJobs().catch(console.error).finally(pollJobs); }, 10_000);
  pollJobs();

  buildSettings();
  // Show the dashboard shell immediately (status rows read “Checking…”) so sidecar
  // latency — bun cold start + `pi --version` — never leaves a blank window.
  showScreen("dash");
  renderStatus();
  await refreshStatus();
  // First run (transcription not configured) lands on the settings page; otherwise
  // stay on the dashboard.
  if (status && !status.volcano.configured) await openSettings();
  else if (status?.pi.available) ensureAgent(false).then(() => refreshStatus());
});
