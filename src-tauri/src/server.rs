use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::process_util::{configure_hidden_command, resolve_bundled_node, resolve_node_executable};

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

fn watchdog_loop(app: AppHandle) {
    bootstrap_embedded_server(&app);

    let mut unhealthy_streak = 0u8;

    while !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
        if child_exited(&app) {
            unhealthy_streak = 3;
        }

        if server_healthy() {
            unhealthy_streak = 0;
            RESTART_BACKOFF_SECS.store(1, Ordering::SeqCst);
        } else {
            unhealthy_streak = unhealthy_streak.saturating_add(1);
        }

        if unhealthy_streak >= 3 {
            stop_child(&app);
            if !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                if let Some(child) = start_embedded_server(&app) {
                    if let Some(state) = app.try_state::<EmbeddedServer>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(child);
                        }
                    }
                    for _ in 0..40 {
                        thread::sleep(Duration::from_millis(250));
                        if server_healthy() {
                            log::info!("[DevFleet] embedded API server recovered");
                            unhealthy_streak = 0;
                            RESTART_BACKOFF_SECS.store(1, Ordering::SeqCst);
                            break;
                        }
                    }
                }
            }
            let backoff = RESTART_BACKOFF_SECS.load(Ordering::SeqCst).min(30);
            RESTART_BACKOFF_SECS.store((backoff * 2).min(30), Ordering::SeqCst);
            interruptible_sleep(backoff);
            continue;
        }

        if !has_child(&app) && !server_healthy() {
            if let Some(child) = start_embedded_server(&app) {
                if let Some(state) = app.try_state::<EmbeddedServer>() {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = Some(child);
                    }
                }
            }
        }

        thread::sleep(Duration::from_secs(3));
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
    if server_healthy() || has_child(app) {
        return;
    }
    if let Some(child) = start_embedded_server(app) {
        if let Some(state) = app.try_state::<EmbeddedServer>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = Some(child);
            }
        }
        for _ in 0..40 {
            thread::sleep(Duration::from_millis(250));
            if server_healthy() {
                log::info!("[DevFleet] embedded API server ready");
                return;
            }
        }
        log::warn!("[DevFleet] embedded API server started but health check pending");
    }
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

fn start_embedded_server(app: &AppHandle) -> Option<Child> {
    let script = resolve_server_script(app)?;
    let server_dir = script.parent()?.to_path_buf();
    let data_dir = app.path().app_data_dir().ok()?;
    let db_file = data_dir.join("devfleet.db");
    std::fs::create_dir_all(&data_dir).ok()?;

    let node = resolve_bundled_node(&server_dir)
        .or_else(resolve_node_executable)
        .unwrap_or_else(|| "node".into());
    log::info!("[DevFleet] embedded server node: {node}");
    let mut command = std::process::Command::new(node);
    configure_hidden_command(&mut command);
    command
        .current_dir(&server_dir)
        .arg(&script)
        .env("PORT", "3001")
        .env("DEVFLEET_DB_FILE", db_file.to_string_lossy().into_owned());

    match command.spawn() {
        Ok(child) => {
            log::info!("[DevFleet] starting embedded API server");
            Some(child)
        }
        Err(error) => {
            log::warn!("[DevFleet] could not start embedded server: {error}");
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
