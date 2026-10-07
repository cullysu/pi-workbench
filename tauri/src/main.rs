#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Pi Workbench — Tauri shell. Spawns the bundled node runtime (server.mjs) and
// loads its UI in a WebView2 window. Parity with the Electron shell: runtime.zip
// fingerprint extract, system-node fallback, port reuse, single instance.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

struct ServerChild {
    child: Mutex<Option<Child>>,
    owned: Mutex<bool>,
}

fn port() -> u16 {
    static PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
    *PORT.get_or_init(|| std::env::var("PIWB_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(32123))
}
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static VIEWER_SEQ: AtomicU64 = AtomicU64::new(1);

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

/// Open an external page inside an app-owned viewer window (never the system browser).
fn open_viewer(app: &tauri::AppHandle, url: tauri::Url) -> tauri::Result<tauri::WebviewWindow> {
    let n = VIEWER_SEQ.fetch_add(1, Ordering::Relaxed);
    let host = url.host_str().unwrap_or("page").to_string();
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        format!("viewer-{n}"),
        tauri::WebviewUrl::External(url),
    )
    .title(format!("Pi Workbench · {host}"))
    .inner_size(1200.0, 850.0)
    .on_new_window(move |_u, _f| {
        // links that want a new window also stay inside the app
        match APP.get().and_then(|h| open_viewer(h, _u.clone()).ok()) {
            Some(w) => tauri::webview::NewWindowResponse::Create { window: w },
            None => tauri::webview::NewWindowResponse::Deny,
        }
    });
    builder.build()
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
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
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

/// The port alone is not identity: a foreign process on port() must not get its page
/// loaded into the shell. The workbench's unauthenticated index embeds a per-boot
/// token bootstrap — requiring that marker is a cheap handshake.
fn workbench_serving(port: u16) -> bool {
    use std::io::{Read, Write};
    let mut stream = match TcpStream::connect(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let req = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = stream.take(65536).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).contains("__API_TOKEN")
}

/// Verify the CI-written runtime manifest (sha256 per file) against the extracted
/// tree — parity with the Electron shell. A v1.1.2-class assembly omission must die
/// here loudly, not as a module-not-found crash inside the spawned server.
fn verify_runtime_manifest(dir: &Path) -> Result<(), String> {
    let mf_path = dir.join("manifest.json");
    if !mf_path.exists() {
        return Ok(()); // dev run without a manifest — nothing to check
    }
    use sha2::{Digest, Sha256};
    let txt = std::fs::read_to_string(&mf_path).map_err(|e| format!("manifest unreadable: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| format!("manifest unparsable: {e}"))?;
    let files = v
        .get("files")
        .and_then(|f| f.as_object())
        .ok_or_else(|| "manifest has no files map".to_string())?;
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

/// Extract runtime.zip when the fingerprint changed.
/// Stamp = `version|zipSize|zipMtime` — same scheme as the Electron shell.
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
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| format!("clear runtime failed: {e}"))?;
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tar = Path::new(&std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
        .join("System32")
        .join("tar.exe");
    let status = Command::new(tar)
        .args(["-xf"])
        .arg(zip)
        .arg("-C")
        .arg(dir)
        .creation_flags(no_window())
        .status()
        .map_err(|e| format!("tar spawn failed: {e}"))?;
    if !status.success() {
        return Err(format!("tar extract failed: {}", status.code().unwrap_or(-1)));
    }
    std::fs::write(&stamp, sig).map_err(|e| e.to_string())?;
    Ok(())
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

            let already_up = workbench_serving(port());
            let mut owned = false;
            let mut child = None;
            if !already_up {
                let node = find_node(&runtime_dir).ok_or_else(|| "node.exe not found".to_string())?;
                let c = Command::new(&node)
                    .arg(runtime_dir.join("server.mjs"))
                    .current_dir(&runtime_dir)
                    .env("PIWB_PARENT_PID", std::process::id().to_string())
                    .creation_flags(no_window())
                    .spawn()
                    .map_err(|e| format!("node spawn failed: {e}"))?;
                child = Some(c);
                owned = true;
            }

            if !wait_port(port(), Duration::from_secs(30)) {
                return Err("local server did not start in time".into());
            }

            *app.state::<ServerChild>().child.lock().unwrap() = child;
            *app.state::<ServerChild>().owned.lock().unwrap() = owned;
            let _ = APP.set(app.handle().clone());

            let handle = app.handle().clone();
            let nav_handle = handle.clone();
            let url = format!("http://127.0.0.1:{}/", port()).parse()?;
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("Pi Workbench")
                .inner_size(1480.0, 940.0)
                .min_inner_size(1080.0, 680.0)
                .on_navigation(move |u| {
                    // the workbench window never navigates away — external pages
                    // open inside app-owned viewer windows instead
                    if is_local_app(u) {
                        true
                    } else {
                        let _ = open_viewer(&nav_handle, u.clone());
                        false
                    }
                })
                .on_new_window(move |u, _f| {
                    match open_viewer(&handle, u.clone()) {
                        Ok(w) => tauri::webview::NewWindowResponse::Create { window: w },
                        Err(_) => tauri::webview::NewWindowResponse::Deny,
                    }
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
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
