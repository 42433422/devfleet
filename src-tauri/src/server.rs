use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::process_util::{configure_hidden_command, resolve_bundled_node, resolve_node_executable};

const EMBEDDED_API_PORT: u16 = 3001;

pub struct EmbeddedServer(pub Mutex<Option<Child>>);

impl Default for EmbeddedServer {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

static WATCHDOG_STARTED: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);
static RESTART_BACKOFF_SECS: AtomicU64 = AtomicU64::new(1);

pub fn ensure_server_running(app: &AppHandle) {
    if WATCHDOG_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let handle = app.clone();
    thread::spawn(move || watchdog_loop(handle));
}

pub fn shutdown_embedded_server(app: &AppHandle) {
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
    stop_child(app);
}

pub fn restart_embedded_server(app: &AppHandle) {
    log::info!("[DevFleet] manual embedded server restart requested");
    stop_child(app);
    kill_stale_listeners_on_port(EMBEDDED_API_PORT, None);
    if let Some(child) = start_embedded_server(app) {
        if let Some(state) = app.try_state::<EmbeddedServer>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = Some(child);
            }
        }
        for _ in 0..120 {
            thread::sleep(Duration::from_millis(250));
            if server_healthy() {
                log::info!("[DevFleet] embedded API server restarted");
                return;
            }
        }
        log_last_server_error(app);
    }
}

fn watchdog_loop(app: AppHandle) {
    bootstrap_embedded_server(&app);

    let mut unhealthy_streak = 0u8;

    while !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
        if child_exited(&app) {
            log::warn!("[DevFleet] embedded API server process exited");
            log_last_server_error(&app);
            unhealthy_streak = 2;
        }

        if server_healthy() {
            unhealthy_streak = 0;
            RESTART_BACKOFF_SECS.store(1, Ordering::SeqCst);
        } else {
            unhealthy_streak = unhealthy_streak.saturating_add(1);
        }

        if unhealthy_streak >= 2 {
            stop_child(&app);
            kill_stale_listeners_on_port(EMBEDDED_API_PORT, child_pid(&app));
            if !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                if let Some(child) = start_embedded_server(&app) {
                    if let Some(state) = app.try_state::<EmbeddedServer>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(child);
                        }
                    }
                    for _ in 0..120 {
                        thread::sleep(Duration::from_millis(250));
                        if server_healthy() {
                            log::info!("[DevFleet] embedded API server recovered");
                            unhealthy_streak = 0;
                            RESTART_BACKOFF_SECS.store(1, Ordering::SeqCst);
                            break;
                        }
                    }
                    if !server_healthy() {
                        log_last_server_error(&app);
                    }
                }
            }
            let backoff = RESTART_BACKOFF_SECS.load(Ordering::SeqCst).min(30);
            RESTART_BACKOFF_SECS.store((backoff * 2).min(30), Ordering::SeqCst);
            interruptible_sleep(backoff);
            continue;
        }

        if !has_child(&app) && !server_healthy() {
            kill_stale_listeners_on_port(EMBEDDED_API_PORT, None);
            if let Some(child) = start_embedded_server(&app) {
                if let Some(state) = app.try_state::<EmbeddedServer>() {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = Some(child);
                    }
                }
            }
        }

        let sleep_secs = if unhealthy_streak > 0 { 1 } else { 3 };
        thread::sleep(Duration::from_secs(sleep_secs));
    }
}

fn interruptible_sleep(seconds: u64) {
    for _ in 0..seconds * 10 {
        if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn has_child(app: &AppHandle) -> bool {
    app.try_state::<EmbeddedServer>()
        .and_then(|state| state.0.lock().ok().map(|guard| guard.is_some()))
        .unwrap_or(false)
}

fn child_exited(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<EmbeddedServer>() else {
        return false;
    };
    let Ok(mut guard) = state.0.lock() else {
        return false;
    };
    let Some(child) = guard.as_mut() else {
        return false;
    };
    match child.try_wait() {
        Ok(Some(_status)) => {
            *guard = None;
            true
        }
        Ok(None) => false,
        Err(_) => {
            *guard = None;
            true
        }
    }
}

fn stop_child(app: &AppHandle) {
    let Some(state) = app.try_state::<EmbeddedServer>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn bootstrap_embedded_server(app: &AppHandle) {
    if has_child(app) && server_healthy() {
        return;
    }
    if server_healthy() && !has_child(app) {
        log::warn!("[DevFleet] port {EMBEDDED_API_PORT} responds but is not owned by DevFleet; reclaiming");
        kill_stale_listeners_on_port(EMBEDDED_API_PORT, None);
    }
    if let Some(child) = start_embedded_server(app) {
        if let Some(state) = app.try_state::<EmbeddedServer>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = Some(child);
            }
        }
        for _ in 0..120 {
            thread::sleep(Duration::from_millis(250));
            if server_healthy() {
                log::info!("[DevFleet] embedded API server ready");
                return;
            }
        }
        log::warn!("[DevFleet] embedded API server started but health check pending");
        log_last_server_error(app);
    }
}

fn child_pid(app: &AppHandle) -> Option<u32> {
    let state = app.try_state::<EmbeddedServer>()?;
    let guard = state.0.lock().ok()?;
    guard.as_ref().map(|child| child.id())
}

fn kill_stale_listeners_on_port(port: u16, except_pid: Option<u32>) {
    #[cfg(unix)]
    {
        let output = StdCommand::new("lsof")
            .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
            .output();
        let Ok(output) = output else {
            return;
        };
        if !output.status.success() {
            return;
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let Ok(pid) = line.trim().parse::<u32>() else {
                continue;
            };
            if except_pid == Some(pid) {
                continue;
            }
            log::warn!("[DevFleet] stopping stale listener pid {pid} on port {port}");
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            thread::sleep(Duration::from_millis(200));
        }
    }
    #[cfg(windows)]
    {
        let _ = (port, except_pid);
    }
}

pub fn is_local_server_healthy() -> bool {
    server_healthy()
}

#[tauri::command]
pub fn restart_embedded_server_cmd(app: AppHandle) {
    restart_embedded_server(&app);
}

fn server_healthy() -> bool {
    const HEALTH_URLS: [&str; 2] = [
        "http://127.0.0.1:3001/api/health",
        "http://localhost:3001/api/health",
    ];
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(2000))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    HEALTH_URLS.iter().any(|url| {
        client
            .get(*url)
            .send()
            .ok()
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    })
}

fn resolve_embedded_node(server_dir: &Path) -> String {
    if let Some(bundled) = resolve_bundled_node(server_dir) {
        return bundled;
    }
    log::warn!(
        "[DevFleet] bundled Node runtime missing under {}; falling back to system node",
        server_dir.display()
    );
    resolve_node_executable().unwrap_or_else(|| "node".into())
}

fn open_server_log(data_dir: &Path) -> Option<File> {
    if let Err(error) = std::fs::create_dir_all(data_dir) {
        log::error!(
            "[DevFleet] cannot create data dir {}: {error}",
            data_dir.display()
        );
        return None;
    }
    let log_path = data_dir.join("devfleet-server.log");
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok()
        .inspect(|_| log::info!("[DevFleet] embedded server log: {}", log_path.display()))
}

fn log_last_server_error(app: &AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let log_path = data_dir.join("devfleet-server.log");
    let Ok(raw) = std::fs::read_to_string(&log_path) else {
        return;
    };
    let tail: String = raw.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect();
    if !tail.is_empty() {
        log::warn!("[DevFleet] embedded server log tail:\n{tail}");
    }
}

fn start_embedded_server(app: &AppHandle) -> Option<Child> {
    let script = resolve_server_script(app)?;
    let server_dir = script.parent()?.to_path_buf();
    let data_dir = app.path().app_data_dir().ok()?;
    let db_file = data_dir.join("devfleet.db");
    let node_modules = server_dir.join("node_modules");
    let node = resolve_embedded_node(&server_dir);
    log::info!("[DevFleet] embedded server db: {}", db_file.display());
    log::info!("[DevFleet] embedded server node: {node}");

    let mut command = std::process::Command::new(&node);
    if let Some(log_file) = open_server_log(&data_dir) {
        if let Ok(stdout) = log_file.try_clone() {
            command.stdout(Stdio::from(stdout));
        }
        command.stderr(Stdio::from(log_file));
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }
    configure_hidden_command(&mut command);
    command
        .current_dir(&server_dir)
        .arg(&script)
        .env_remove("PORT")
        .env_remove("DEVFLEET_TUNNEL")
        .env("PORT", "3001")
        .env("DEVFLEET_DESKTOP", "1")
        .env("DEVFLEET_DATA_DIR", data_dir.to_string_lossy().into_owned())
        .env("DEVFLEET_DB_FILE", db_file.to_string_lossy().into_owned())
        .env("NODE_PATH", node_modules.to_string_lossy().into_owned());

    match command.spawn() {
        Ok(child) => {
            log::info!("[DevFleet] starting embedded API server on http://127.0.0.1:3001");
            Some(child)
        }
        Err(error) => {
            log::warn!("[DevFleet] could not start embedded server: {error}");
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(data_dir.join("devfleet-server.log"))
            {
                let _ = writeln!(file, "[DevFleet] spawn failed: {error}");
            }
            None
        }
    }
}

fn resolve_server_script(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve(
            "server/devfleet-server.cjs",
            tauri::path::BaseDirectory::Resource,
        )
        .ok()
        .filter(|path| path.exists())
}
