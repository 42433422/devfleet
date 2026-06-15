use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

pub struct EmbeddedServer(pub Mutex<Option<Child>>);

impl Default for EmbeddedServer {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

pub fn ensure_server_running(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        if server_healthy() {
            return;
        }
        if let Some(child) = start_embedded_server(&handle) {
            if let Some(state) = handle.try_state::<EmbeddedServer>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(child);
                }
            }
            for _ in 0..20 {
                thread::sleep(Duration::from_millis(250));
                if server_healthy() {
                    log::info!("[DevFleet] embedded API server ready on http://localhost:3001");
                    return;
                }
            }
            log::warn!("[DevFleet] embedded API server started but health check timed out");
        }
    });
}

fn server_healthy() -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .ok()
        .and_then(|client| client.get("http://localhost:3001/api/health").send().ok())
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn start_embedded_server(app: &AppHandle) -> Option<Child> {
    let script = resolve_server_script(app)?;
    let data_dir = app.path().app_data_dir().ok()?;
    let db_file = data_dir.join("db.json");
    std::fs::create_dir_all(&data_dir).ok()?;

    let mut command = node_command();
    command
        .arg(script)
        .env("PORT", "3001")
        .env("DEVFLEET_DB_FILE", db_file)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

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

fn node_command() -> Command {
    for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "node"] {
        let path = PathBuf::from(candidate);
        if candidate == "node" || path.is_file() {
            let mut command = Command::new(candidate);
            command.env(
                "PATH",
                format!(
                    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
                    std::env::var("PATH").unwrap_or_default()
                ),
            );
            return command;
        }
    }
    Command::new("node")
}
