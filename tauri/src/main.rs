#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Pi Workbench — Tauri shell. Spawns the bundled node runtime (server.mjs) and
// loads its UI in a WebView2 window. Parity with the Electron shell: runtime.zip
// fingerprint extract, system-node fallback, port reuse, single instance.
//
// P3-14 (v1.3.9 review): this shell is Windows-only, and said so nowhere. The code
// looks for `node.exe` (bundled, then the two Program Files locations, then a `;`
// split of PATH), extracts the runtime with the hardcoded `%SystemRoot%\System32\tar.exe`,
// calls `CommandExt::creation_flags` on every spawn, and bundles only NSIS. A macOS or
// Linux build therefore did not merely lack a bundle target — it failed to compile, with
// errors that pointed at `creation_flags` instead of at the real constraint. That is
// stated here and in the bundle target list, so the failure names itself.
#[cfg(not(windows))]
compile_error!(
    "the Tauri shell in this repository is Windows-only (WebView2 + NSIS + System32\\tar.exe + \
     CommandExt::creation_flags). Build the Electron shell for Linux/macOS — see README 'Supported platforms'."
);

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

struct ServerChild {
    child: Mutex<Option<Child>>,
    owned: Mutex<bool>,
}

// v1.3.8 review P3-11: Electron has supervised its server since the beginning — a
// crash there is a 1.5s blip. The Tauri shell only ever spawned once, so after any
// abnormal exit the window kept talking to a dead port until the user restarted the app.
static QUITTING: AtomicBool = AtomicBool::new(false);

fn port() -> u16 {
    static PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
    *PORT.get_or_init(|| std::env::var("PIWB_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(32123))
}
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(windows)]
fn no_window() -> u32 {
    // CREATE_NO_WINDOW — a GUI app spawning console processes must not flash terminals
    0x0800_0000
}
#[cfg(not(windows))]
fn no_window() -> u32 {
    0
}

fn is_local_app(u: &tauri::Url) -> bool {
    u.host_str() == Some("127.0.0.1") && u.port() == Some(port())
}

/// Open an external page in the system's default browser — never inside an
/// app-owned webview: remote pages must not run with the desktop shell's context.
fn open_external(url: &tauri::Url) {
    if url.scheme() != "http" && url.scheme() != "https" {
        return; // only web pages; file:, javascript: and custom schemes are dropped
    }
    let s = url.as_str().to_string();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&s).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&s).spawn();
    #[cfg(target_os = "windows")]
    {
        // explorer.exe rather than `cmd /c start`: no shell interpolation, the URL stays one argument
        let _ = std::process::Command::new("explorer.exe").arg(&s).creation_flags(no_window()).spawn();
    }
}

#[cfg(windows)]
fn another_instance_running() -> bool {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name: Vec<u16> = "Local\\PiWorkbenchSingleInstance"
        .encode_utf16()
        .chain([0])
        .collect();
    unsafe {
        CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        GetLastError() == ERROR_ALREADY_EXISTS
    }
}

#[cfg(not(windows))]
fn another_instance_running() -> bool {
    false
}

fn wait_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn find_node(runtime_dir: &Path) -> Option<PathBuf> {
    let bundled = runtime_dir.join("node.exe");
    if bundled.exists() {
        return Some(bundled);
    }
    for p in ["C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files (x86)\\nodejs\\node.exe"] {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    which_node_from_path()
}

fn which_node_from_path() -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in path.split(';') {
        let p = PathBuf::from(dir).join("node.exe");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// F01 (v1.3.5 audit): identity is a challenge-response, never a raw token on an
/// unverified connection. The shell sends a fresh random nonce with NO token; only
/// the genuine server (holding this shell's token) can answer
/// x-piwb-proof = HMAC-SHA256(token, nonce). A port pre-occupier used to pass the
/// old `HTTP/1. + 200` check AND get handed the token.
fn workbench_serving(port: u16, token: &str) -> bool {
    use std::io::{Read, Write};
    // 16 random bytes hex — nonce freshness is what makes a captured proof useless
    let nonce = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
            .to_le_bytes());
        h.update(std::process::id().to_le_bytes());
        let d = h.finalize();
        d.iter().take(16).map(|b| format!("{b:02x}")).collect::<String>()
    };
    let expect = hmac_sha256_hex(token.as_bytes(), nonce.as_bytes());
    let mut stream = match TcpStream::connect(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let req = format!("GET /api/identify?n={nonce} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    // a byte cap is not a time cap: a process holding the port that accepts but
    // never answers would stall setup forever — 3s and move on (audit #32)
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut buf = Vec::new();
    let _ = stream.take(65536).read_to_end(&mut buf);
    let head = String::from_utf8_lossy(&buf);
    if !(head.starts_with("HTTP/1.") && head.contains(" 200 ")) {
        return false;
    }
    match proof_from_headers(&head) {
        Some(p) => constant_time_eq(p.as_bytes(), expect.as_bytes()),
        None => false,
    }
}

/// HMAC-SHA256 (RFC 2104) over the existing sha2 dependency — no new crates.
fn hmac_sha256_hex(key: &[u8], msg: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let mut h = Sha256::new();
        h.update(key);
        k[..32].copy_from_slice(&h.finalize());
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let ih = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(ih);
    outer.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn proof_from_headers(head: &str) -> Option<String> {
    for line in head.lines() {
        if let Some(v) = line.strip_prefix("x-piwb-proof:") {
            let v = v.trim();
            if v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(v.to_ascii_lowercase());
            }
            return None;
        }
    }
    None
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The server persists its per-boot token to ~/.pi-workbench/token (0600) for the
/// desktop shell; retry a few seconds — the file lands when the server starts listening.
fn read_server_token(timeout: Duration) -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if home.is_empty() {
        return None;
    }
    let path = Path::new(&home).join(".pi-workbench").join("token");
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(txt) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                if let Some(t) = v.get("token").and_then(|t| t.as_str()) {
                    return Some(t.to_string());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    None
}

/// Verify the CI-written runtime manifest (sha256 per file) against the extracted
/// tree — parity with the Electron shell. A v1.1.2-class assembly omission must die
/// here loudly, not as a module-not-found crash inside the spawned server.
fn verify_runtime_manifest(dir: &Path) -> Result<(), String> {
    let mf_path = dir.join("manifest.json");
    if !mf_path.exists() {
        // packaged installs always ship a manifest — absence means the runtime
        // tree was swapped, not that there is nothing to check. Dev stays exempt.
        if cfg!(debug_assertions) {
            return Ok(());
        }
        return Err("runtime manifest missing — refusing to serve an unverifiable tree".to_string());
    }
    use sha2::{Digest, Sha256};
    let txt = std::fs::read_to_string(&mf_path).map_err(|e| format!("manifest unreadable: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| format!("manifest unparsable: {e}"))?;
    let files = v
        .get("files")
        .and_then(|f| f.as_object())
        .ok_or_else(|| "manifest has no files map".to_string())?;
    if files.is_empty() {
        return Err("runtime manifest covers zero files".to_string());
    }
    let mut bad: Vec<String> = Vec::new();
    let mut checked = 0usize;
    for (rel, meta) in files {
        checked += 1;
        let want_size = meta.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
        let want_hash = meta.get("sha256").and_then(|s| s.as_str()).unwrap_or("");
        let mut hasher = Sha256::new();
        let mut size = 0u64;
        match std::fs::File::open(dir.join(rel)) {
            Ok(mut f) => {
                let mut buf = [0u8; 65536];
                loop {
                    match std::io::Read::read(&mut f, &mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            size += n as u64;
                            hasher.update(&buf[..n]);
                        }
                        Err(_) => {
                            bad.push(rel.clone());
                            break;
                        }
                    }
                }
            }
            Err(_) => {
                bad.push(rel.clone());
                continue;
            }
        }
        if bad.last().map(|b| b == rel).unwrap_or(false) {
            continue;
        }
        let got = hasher.finalize();
        let mut hex = String::with_capacity(64);
        for b in got {
            hex.push_str(&format!("{b:02x}"));
        }
        if size != want_size || hex != want_hash {
            if bad.len() < 8 {
                bad.push(rel.clone());
            }
        }
    }
    if bad.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "运行时文件校验失败（共 {checked} 项，前几个不匹配: {}）——安装可能损坏，请重新安装",
            bad.join(", ")
        ))
    }
}

/// Is this archive member name safe to extract under the runtime directory?
///
/// v1.4.0 review #4: the Electron shell has always refused zip-slip members before
/// writing anything (electron-main.cjs: "zip-slip blocked"), but this shell handed the
/// archive straight to `tar.exe` and only checked hashes AFTERWARDS — so an archive whose
/// members escape the destination would have written its files first and been rejected
/// second. Splitting on both separators catches `../`, `..\` and mixed forms; a `:` in
/// any component rejects drive-relative (`C:evil`) and NTFS alternate-data-stream names.
fn member_path_is_safe(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return false; // absolute or UNC
    }
    for part in name.split(['/', '\\']) {
        if part == ".." {
            return false;
        }
        if part.contains(':') {
            return false;
        }
    }
    true
}

/// List the archive with the same `tar.exe` that will extract it and refuse the whole
/// thing if any member could land outside the destination. The listing and the
/// extraction therefore agree on what the members are.
fn assert_members_are_safe(zip: &Path, tar: &Path) -> Result<(), String> {
    let out = Command::new(tar)
        .arg("-tf")
        .arg(zip)
        .creation_flags(no_window())
        .output()
        .map_err(|e| format!("tar list failed: {e}"))?;
    if !out.status.success() {
        return Err(format!("runtime.zip is not a readable archive (tar -tf exit {})", out.status.code().unwrap_or(-1)));
    }
    let listing = String::from_utf8_lossy(&out.stdout);
    let mut seen = 0usize;
    for line in listing.lines() {
        let name = line.trim_end_matches('\r');
        if name.is_empty() {
            continue;
        }
        seen += 1;
        if !member_path_is_safe(name) {
            return Err(format!("runtime.zip contains an unsafe member path — refusing to extract: {name}"));
        }
    }
    if seen == 0 {
        return Err("runtime.zip lists zero members — refusing to extract".to_string());
    }
    Ok(())
}

/// Extract runtime.zip when the fingerprint changed.
/// Stamp = `version|zipSize|zipMtime` — same scheme as the Electron shell.
///
/// v1.4.0 review #4, second half: the stamp used to be written BEFORE
/// `verify_runtime_manifest` ran, so a tree that failed verification was already stamped
/// as current — the next launch skipped extraction on the matching stamp and failed the
/// identical check again, permanently, with no way back short of reinstalling. The tree
/// is now built in a sibling directory, verified there, and only then swapped in; the
/// stamp is written last, so "extracted" and "verified" cannot come apart.
fn ensure_runtime(zip: &Path, dir: &Path, version: &str) -> Result<(), String> {
    let stamp = dir.join(".version");
    let mut sig = format!("v{version}");
    let meta = std::fs::metadata(zip).map_err(|e| format!("runtime.zip missing: {e}"))?;
    let mtime = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    sig += &format!("|{}|{}", meta.len(), mtime);
    if dir.join("server.mjs").exists()
        && stamp.exists()
        && std::fs::read_to_string(&stamp).unwrap_or_default().trim() == sig
    {
        return Ok(());
    }
    let tar = Path::new(&std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
        .join("System32")
        .join("tar.exe");
    assert_members_are_safe(zip, &tar)?;
    // build in a sibling of the real dir: same volume, so the swap below is a rename
    let staging = dir.with_file_name(format!(
        "{}.staging-{}",
        dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "runtime".into()),
        std::process::id()
    ));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| format!("clear staging failed: {e}"))?;
    }
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let status = Command::new(&tar)
        .args(["-xf"])
        .arg(zip)
        .arg("-C")
        .arg(&staging)
        .creation_flags(no_window())
        .status()
        .map_err(|e| format!("tar spawn failed: {e}"))?;
    if !status.success() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("tar extract failed: {}", status.code().unwrap_or(-1)));
    }
    // verify in the staging tree — the live tree keeps serving whatever it had
    if let Err(e) = verify_runtime_manifest(&staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("candidate runtime rejected, keeping the existing tree: {e}"));
    }
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| format!("clear runtime failed: {e}"))?;
    }
    std::fs::rename(&staging, dir).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        format!("runtime swap failed: {e}")
    })?;
    std::fs::write(&stamp, sig).map_err(|e| e.to_string())?;
    Ok(())
}

/// Spawn the bundled server. NODE_OPTIONS/NODE_PATH are removed: a planted value would
/// inject modules into server.mjs before any of our checks run (audit #33).
///
/// P1-3 (v1.3.9 review): the token is HANDED DOWN, never rediscovered. Previously the
/// shell spawned a server that generated its own random per-boot token and wrote it to
/// the 0600 token file; the shell read that file once at startup and baked it into the
/// webview. When the supervisor restarted the server it generated a NEW token, so the
/// already-loaded page kept presenting the old one and every /api call and WS upgrade
/// 403'd until the user reloaded. Passing PIWB_TOKEN makes the token ours and stable
/// across restarts — the same model the Electron shell has always used.
fn spawn_node_server(node: &Path, runtime_dir: &Path, token: &str) -> std::io::Result<Child> {
    Command::new(node)
        .arg(runtime_dir.join("server.mjs"))
        .current_dir(runtime_dir)
        .env("PIWB_PARENT_PID", std::process::id().to_string())
        .env("PIWB_TOKEN", token)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .creation_flags(no_window())
        .spawn()
}

/// The shell's own per-launch token. 32 hex chars (128 bits) from sha256 over the clock,
/// the pid and a counter — no `rand` crate, and it never leaves this process except as
/// the child's environment and the webview's init script.
fn shell_token() -> String {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
                    .to_le_bytes(),
            );
            h.update(std::process::id().to_le_bytes());
            h.update(b"pi-workbench-tauri-shell-token");
            let d = h.finalize();
            d.iter().map(|b| format!("{b:02x}")).collect::<String>()
        })
        .clone()
}

/// v1.3.8 review P3-11: watch the server we own and restart it after an abnormal exit —
/// the same 1.5s grace + 2-restart budget Electron has. A deliberately stopped child
/// (app quitting) or a healthy one just returns to the loop.
fn start_supervisor(app: tauri::AppHandle, node: PathBuf, runtime_dir: PathBuf, token: String) {
    std::thread::spawn(move || {
        let mut restarts: u32 = 0;
        let mut last_start = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            if QUITTING.load(Ordering::Relaxed) {
                return;
            }
            let Some(state) = app.try_state::<ServerChild>() else { return };
            let exited = {
                let mut guard = state.child.lock().unwrap();
                match guard.as_mut() {
                    Some(c) => !matches!(c.try_wait(), Ok(None)),
                    None => false, // the Exit handler already took it
                }
            };
            if !exited {
                continue;
            }
            if last_start.elapsed() > Duration::from_secs(300) {
                restarts = 0; // stayed up five minutes: the earlier crashes were transient
            }
            if restarts >= 2 {
                continue; // budget spent — the page shows its own connection error, do not loop
            }
            restarts += 1;
            std::thread::sleep(Duration::from_millis(1500));
            if QUITTING.load(Ordering::Relaxed) {
                return;
            }
            // same token every time — the loaded page must stay authenticated across a
            // restart (P1-3): a fresh token here would strand the webview with stale creds
            match spawn_node_server(&node, &runtime_dir, &token) {
                Ok(c) => {
                    *state.child.lock().unwrap() = Some(c);
                    *state.owned.lock().unwrap() = true;
                    last_start = Instant::now();
                }
                Err(_) => { /* stay within budget; the next tick retries */ }
            }
        }
    });
}

fn main() {
    if another_instance_running() {
        std::process::exit(0);
    }

    tauri::Builder::default()
        .manage(ServerChild { child: Mutex::new(None), owned: Mutex::new(false) })
        .setup(|app| {
            let version = app.package_info().version.to_string();
            let resource_zip = app
                .path()
                .resolve("pkg-runtime.zip", tauri::path::BaseDirectory::Resource)?;
            let zip: PathBuf = if resource_zip.exists() {
                resource_zip
            } else {
                // dev fallback: cargo run without bundling — walk up to the repo copy
                let mut dir = std::env::current_exe()?;
                let mut found = None;
                for _ in 0..5 {
                    dir = match dir.parent() {
                        Some(d) => d.to_path_buf(),
                        None => break,
                    };
                    let cand = dir.join("pkg-runtime.zip");
                    if cand.exists() {
                        found = Some(cand);
                        break;
                    }
                }
                found.ok_or_else(|| "pkg-runtime.zip not found".to_string())?
            };

            let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
                Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
                    .join("AppData")
                    .join("Local")
                    .to_string_lossy()
                    .to_string()
            });
            let runtime_dir = PathBuf::from(local)
                .join("pi-workbench-tauri")
                .join("runtime");
            ensure_runtime(&zip, &runtime_dir, &version)?;
            verify_runtime_manifest(&runtime_dir)?;

            let already_up = TcpStream::connect(("127.0.0.1", port())).is_ok();
            let mut owned = false;
            let mut child = None;
            let mut sup_node: Option<PathBuf> = None;
            // P1-3: one token for this launch, reused by every spawn below
            let token = shell_token();
            if !already_up {
                let node = find_node(&runtime_dir).ok_or_else(|| "node.exe not found".to_string())?;
                // NODE_OPTIONS/NODE_PATH must not leak into the bundled runtime: a
                // planted NODE_OPTIONS would inject modules into server.mjs before
                // any of our checks run — Electron strips these, so does the Tauri
                // shell now (audit #33)
                let c = spawn_node_server(&node, &runtime_dir, &token).map_err(|e| format!("node spawn failed: {e}"))?;
                child = Some(c);
                owned = true;
                sup_node = Some(node);
            }

            if !wait_port(port(), Duration::from_secs(30)) {
                return Err("local server did not start in time".into());
            }
            // a server WE started already holds our token. A server that was already up
            // belongs to another shell instance, so its token can only come from its
            // env or the 0600 token file it wrote.
            let shell_token = if owned {
                token.clone()
            } else {
                std::env::var("PIWB_TOKEN").ok()
                    .or_else(|| read_server_token(Duration::from_secs(10)))
                    .ok_or_else(|| "no bootstrap token (env or server token file)".to_string())?
            };
            if !workbench_serving(port(), &shell_token) {
                return Err("the service on the port did not pass identity verification (token handshake failed)".into());
            }

            *app.state::<ServerChild>().child.lock().unwrap() = child;
            *app.state::<ServerChild>().owned.lock().unwrap() = owned;
            let _ = APP.set(app.handle().clone());
            // only a server WE own is ours to restart; an already-running instance
            // belongs to another shell (the second instance exited at startup)
            if let Some(node) = sup_node {
                start_supervisor(app.handle().clone(), node, runtime_dir.clone(), token);
            }

            let url = format!("http://127.0.0.1:{}/", port()).parse()?;
            let init_js = format!("window.__API_TOKEN = {};\n", serde_json::to_string(&shell_token).unwrap_or_else(|_| "\"\"".into()));
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .initialization_script(&init_js)
                .title("Pi Workbench")
                .inner_size(1480.0, 940.0)
                .min_inner_size(1080.0, 680.0)
                .on_navigation(move |u| {
                    // the workbench window never navigates away — external pages go
                    // to the system browser, never an app-owned webview
                    if is_local_app(u) {
                        true
                    } else {
                        open_external(&u);
                        false
                    }
                })
                .on_new_window(|u, _f| {
                    // target=_blank must reach the system browser like a plain navigation —
                    // denying here silently killed the update-download link
                    open_external(&u);
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // tell the supervisor to stand down FIRST — otherwise it may resurrect
                // the server during our own shutdown
                QUITTING.store(true, Ordering::SeqCst);
                let owned = app_handle
                    .try_state::<ServerChild>()
                    .map(|s| *s.owned.lock().unwrap())
                    .unwrap_or(false);
                if owned {
                    if let Some(state) = app_handle.try_state::<ServerChild>() {
                        if let Some(mut child) = state.child.lock().unwrap().take() {
                            // the server spawns pi children (tabs, cron); on Windows kill the
                            // whole tree so nothing outlives the shell
                            #[cfg(windows)]
                            {
                                let _ = std::process::Command::new("taskkill")
                                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                                    .creation_flags(no_window())
                                    .output();
                                let _ = child.kill();
                            }
                            #[cfg(not(windows))]
                            {
                                let _ = child.kill();
                            }
                        }
                    }
                }
            }
        });
}

// P3-21 (v1.3.9 review): `cargo test --locked` compiled and ran ZERO tests, so the one
// piece of this shell that is pure logic — the identity handshake — was only ever covered
// indirectly by a live server. These are known-answer tests from RFC 4231 plus the parser
// and comparison edge cases; nothing here starts a process or touches the network.
#[cfg(test)]
mod tests {
    use super::*;

    // RFC 4231 test case 2 — HMAC-SHA-256("key", "The quick brown fox jumps over the lazy dog")
    #[test]
    fn hmac_matches_rfc4231_case2() {
        assert_eq!(
            hmac_sha256_hex(b"key", b"The quick brown fox jumps over the lazy dog"),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    // RFC 4231 test case 6 — a 131-byte key, i.e. the "hash the key first" branch
    #[test]
    fn hmac_matches_rfc4231_case6_long_key() {
        let key = [0xaau8; 131];
        assert_eq!(
            hmac_sha256_hex(&key, b"Test Using Larger Than Block-Size Key - Hash Key First"),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn proof_header_is_parsed_and_lowercased() {
        let hex = "A".repeat(64);
        let head = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-piwb-proof: {hex}\r\n\r\n");
        assert_eq!(proof_from_headers(&head), Some("a".repeat(64)));
    }

    #[test]
    fn a_malformed_or_absent_proof_is_none() {
        // too short, non-hex, and missing entirely — all must be a refusal, never a guess
        assert_eq!(proof_from_headers("HTTP/1.1 200 OK\r\nx-piwb-proof: deadbeef\r\n"), None);
        assert_eq!(proof_from_headers(&format!("HTTP/1.1 200 OK\r\nx-piwb-proof: {}\r\n", "z".repeat(64))), None);
        assert_eq!(proof_from_headers("HTTP/1.1 200 OK\r\n\r\n"), None);
    }

    #[test]
    fn constant_time_eq_rejects_length_and_content_differences() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
    }

    #[test]
    fn the_shell_token_is_64_hex_chars_and_stable() {
        let a = shell_token();
        let b = shell_token();
        assert_eq!(a.len(), 64, "sha256 hex is 64 chars");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, b, "the supervisor restart path depends on this being stable");
    }

    // v1.4.0 review #4: the member-path predicate that replaces "trust tar.exe, verify after".
    #[test]
    fn ordinary_member_paths_are_safe() {
        for n in ["server.mjs", "lib/cron.mjs", "node_modules/ws/index.js", "./a/b.js", "a/b/c/", "dir\\sub\\file.js"] {
            assert!(member_path_is_safe(n), "{n} should be safe");
        }
    }

    #[test]
    fn traversal_and_absolute_members_are_rejected() {
        for n in [
            "../evil.js",
            "../../evil.js",
            "a/../../evil.js",
            "..\\evil.js",
            "a\\..\\..\\evil.js",
            "a/../b/../../evil.js",
            "/etc/passwd",
            "\\Windows\\System32\\evil.dll",
            "",
        ] {
            assert!(!member_path_is_safe(n), "{n} should be refused");
        }
    }

    #[test]
    fn windows_drive_and_stream_names_are_rejected() {
        // drive-relative and NTFS alternate-data-stream forms never belong in a runtime
        for n in ["C:evil.js", "C:/Windows/evil.dll", "a/b:C", "dir/file.txt:stream"] {
            assert!(!member_path_is_safe(n), "{n} should be refused");
        }
    }

    // The real thing: a zip carrying `../escape.txt`, listed by the real tar.exe that
    // would extract it. This is the check the review could not verify — it is verified here.
    #[cfg(windows)]
    #[test]
    fn a_real_zip_with_a_traversal_member_is_refused_before_extraction() {
        // under the crate's own target/ rather than %TEMP%: the test only needs a scratch
        // directory, and staying inside the build tree keeps it writable everywhere
        let dir = Path::new("target").join(format!("zip-slip-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip = dir.join("evil.zip");
        // build a zip by hand: one stored entry named `../escape.txt`
        let name = b"../escape.txt";
        let body = b"owned";
        let mut out: Vec<u8> = Vec::new();
        let mut crc = 0u32;
        // CRC-32 (IEEE) of the body — required for the local header
        let mut table = [0u32; 256];
        for i in 0..256u32 {
            let mut c = i;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
            }
            table[i as usize] = c;
        }
        crc = !crc;
        for b in body {
            crc = table[((crc ^ *b as u32) & 0xFF) as usize] ^ (crc >> 8);
        }
        crc = !crc;
        let put16 = |v: &mut Vec<u8>, x: u16| v.extend_from_slice(&x.to_le_bytes());
        let put32 = |v: &mut Vec<u8>, x: u32| v.extend_from_slice(&x.to_le_bytes());
        put32(&mut out, 0x04034b50);
        put16(&mut out, 20);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put32(&mut out, crc);
        put32(&mut out, body.len() as u32);
        put32(&mut out, body.len() as u32);
        put16(&mut out, name.len() as u16);
        put16(&mut out, 0);
        out.extend_from_slice(name);
        out.extend_from_slice(body);
        let cd_start = out.len();
        put32(&mut out, 0x02014b50);
        put16(&mut out, 20);
        put16(&mut out, 20);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put32(&mut out, crc);
        put32(&mut out, body.len() as u32);
        put32(&mut out, body.len() as u32);
        put16(&mut out, name.len() as u16);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put32(&mut out, 0);
        put32(&mut out, 0);
        out.extend_from_slice(name);
        let cd_len = out.len() - cd_start;
        put32(&mut out, 0x06054b50);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put16(&mut out, 1);
        put16(&mut out, 1);
        put32(&mut out, cd_len as u32);
        put32(&mut out, cd_start as u32);
        put16(&mut out, 0);
        std::fs::write(&zip, &out).unwrap();

        let tar = Path::new(&std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
            .join("System32")
            .join("tar.exe");
        let res = assert_members_are_safe(&zip, &tar);
        assert!(res.is_err(), "a traversal member must be refused, got {res:?}");
        assert!(
            res.unwrap_err().contains("../escape.txt"),
            "the refusal must name the offending member"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
