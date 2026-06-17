use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::process_util::{
    configure_embedded_server_command, resolve_bundled_node, resolve_bundled_resource,
    resolve_node_executable,
};

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
static COLD_START_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn ensure_server_running(app: &AppHandle) {
    if WATCHDOG_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let handle = app.clone();
    thread::spawn(move || watchdog_loop(handle));
}

/// 冷启动：清孤儿进程、占端口、同步拉起 API，窗口打开前必须成功。
pub fn cold_start_desktop_api(app: &AppHandle) -> Result<(), String> {
    if let Ok(mut guard) = COLD_START_ERROR.lock() {
        *guard = None;
    }
    let data_dir = app.path().app_data_dir().map_err(|e| {
        let message = e.to_string();
        store_cold_start_error(&message);
        message
    })?;
    std::fs::create_dir_all(&data_dir).map_err(|e| {
        let message = e.to_string();
        store_cold_start_error(&message);
        message
    })?;
    enforce_single_instance(&data_dir);
    stop_child(app);
    force_clear_port_for_embedded(None);

    let child = start_embedded_server(app).map_err(|error| {
        store_cold_start_error(&error);
        error
    })?;
    if let Some(state) = app.try_state::<EmbeddedServer>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(child);
        }
    }

    for _ in 0..360 {
        if server_healthy() && has_child(app) {
            log::info!("[DevFleet] embedded API cold start OK");
            if let Ok(mut guard) = COLD_START_ERROR.lock() {
                *guard = None;
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    log_last_server_error(app);
    let message = format!(
        "内嵌 API 在 {EMBEDDED_API_PORT} 未就绪（90s 超时）。请查看 {}",
        data_dir.join("devfleet-server.log").display()
    );
    if let Ok(mut guard) = COLD_START_ERROR.lock() {
        *guard = Some(message.clone());
    }
    Err(message)
}

fn store_cold_start_error(message: &str) {
    if let Ok(mut guard) = COLD_START_ERROR.lock() {
        *guard = Some(message.to_string());
    }
}

pub fn shutdown_embedded_server(app: &AppHandle) {
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
    shutdown_embedded_api(app);
}

pub fn restart_embedded_server(app: &AppHandle) {
    log::info!("[DevFleet] manual embedded server restart requested");
    stop_child(app);
    force_clear_port_for_embedded(None);
    match start_embedded_server(app) {
        Ok(child) => {
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
        Err(error) => log::error!("[DevFleet] restart failed: {error}"),
    }
}

fn watchdog_loop(app: AppHandle) {
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
            purge_orphan_devfleet_api_processes(child_pid(&app));
            kill_stale_listeners_on_port(EMBEDDED_API_PORT, None);
            if !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                match start_embedded_server(&app) {
                    Ok(child) => {
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
                    Err(error) => log::error!("[DevFleet] recovery start failed: {error}"),
                }
            }
            let backoff = RESTART_BACKOFF_SECS.load(Ordering::SeqCst).min(30);
            RESTART_BACKOFF_SECS.store((backoff * 2).min(30), Ordering::SeqCst);
            interruptible_sleep(backoff);
            continue;
        }

        if !has_child(&app) && !server_healthy() {
            purge_orphan_devfleet_api_processes(None);
            kill_stale_listeners_on_port(EMBEDDED_API_PORT, None);
            match start_embedded_server(&app) {
                Ok(child) => {
                    if let Some(state) = app.try_state::<EmbeddedServer>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(child);
                        }
                    }
                }
                Err(error) => log::error!("[DevFleet] watchdog start failed: {error}"),
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
        let pid = child.id();
        let _ = child.kill();
        let _ = child.wait();
        #[cfg(unix)]
        if pid > 0 {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
    }
}

fn shutdown_embedded_api(app: &AppHandle) {
    stop_child(app);
    force_clear_port_for_embedded(None);
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
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    #[cfg(windows)]
    {
        let output = StdCommand::new("netstat").args(["-ano"]).output();
        let Ok(output) = output else {
            return;
        };
        if !output.status.success() {
            return;
        }
        let port_token = format!(":{port}");
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if !line.contains("LISTENING") || !line.contains(&port_token) {
                continue;
            }
            let Some(pid_str) = line.split_whitespace().last() else {
                continue;
            };
            let Ok(pid) = pid_str.parse::<u32>() else {
                continue;
            };
            if pid == 0 || except_pid == Some(pid) {
                continue;
            }
            log::warn!("[DevFleet] stopping stale listener pid {pid} on port {port}");
            terminate_process(pid as i32);
            thread::sleep(Duration::from_millis(200));
        }
    }
}

pub fn is_local_server_healthy() -> bool {
    server_healthy()
}

#[tauri::command]
pub fn restart_embedded_server_cmd(app: AppHandle) {
    restart_embedded_server(&app);
}

#[tauri::command]
pub fn get_cold_start_error() -> Option<String> {
    COLD_START_ERROR.lock().ok().and_then(|guard| guard.clone())
}

#[tauri::command]
pub fn get_embedded_server_log_path(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("devfleet-server.log").display().to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn retry_cold_start(app: AppHandle) -> Result<(), String> {
    cold_start_desktop_api(&app)
}

fn server_healthy() -> bool {
    health_payload()
        .map(|body| {
            body.get("embedded")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
                && body
                    .get("success")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn health_payload() -> Option<serde_json::Value> {
    const HEALTH_URL: &str = "http://127.0.0.1:3001/api/health";
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(2000))
        .build()
        .ok()?;
    let response = client.get(HEALTH_URL).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<serde_json::Value>().ok()
}

/// 冷启动前释放 3001：杀孤儿内嵌进程、开发态 tsx/nodemon，以及占用端口但 embedded=false 的 API。
fn force_clear_port_for_embedded(except_pid: Option<u32>) {
    purge_orphan_devfleet_api_processes(except_pid);
    purge_processes_matching("nodemon", except_pid);
    purge_processes_matching("concurrently", except_pid);
    kill_stale_listeners_on_port(EMBEDDED_API_PORT, except_pid);
    if health_payload().and_then(|body| body.get("embedded").and_then(|value| value.as_bool()))
        == Some(false)
    {
        log::warn!(
            "[DevFleet] port {EMBEDDED_API_PORT} has non-embedded API (dev tsx/nodemon); clearing"
        );
        purge_orphan_devfleet_api_processes(except_pid);
        purge_processes_matching("tsx api/server", except_pid);
        purge_processes_matching("api/server.ts", except_pid);
        purge_processes_matching("nodemon", except_pid);
        kill_stale_listeners_on_port(EMBEDDED_API_PORT, except_pid);
    }
}

fn enforce_single_instance(data_dir: &Path) {
    let lock_path = data_dir.join("devfleet.pid");
    if let Ok(raw) = std::fs::read_to_string(&lock_path) {
        if let Ok(pid) = raw.trim().parse::<i32>() {
            let self_pid = std::process::id() as i32;
            if pid > 0 && pid != self_pid && process_alive(pid) {
                log::warn!("[DevFleet] stopping previous app instance pid {pid}");
                terminate_process(pid);
                purge_orphan_devfleet_api_processes(None);
                kill_stale_listeners_on_port(EMBEDDED_API_PORT, None);
            }
        }
    }
    let _ = std::fs::write(&lock_path, std::process::id().to_string());
}

fn process_alive(pid: i32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid, 0) == 0 }
    }
    #[cfg(windows)]
    {
        use std::process::Command as Cmd;
        Cmd::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .ok()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}

fn terminate_process(pid: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = StdCommand::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    thread::sleep(Duration::from_millis(400));
}

fn purge_orphan_devfleet_api_processes(except_pid: Option<u32>) {
    purge_processes_matching("devfleet-server.cjs", except_pid);
    // 开发态 npm run server / tsx 占 3001 会导致内嵌 API 无法绑定且 health embedded=false
    purge_processes_matching("tsx api/server", except_pid);
    purge_processes_matching("api/server.ts", except_pid);
}

fn purge_processes_matching(pattern: &str, except_pid: Option<u32>) {
    #[cfg(unix)]
    {
        let output = StdCommand::new("pgrep").args(["-f", pattern]).output();
        let Ok(output) = output else {
            return;
        };
        if !output.status.success() {
            return;
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let Ok(pid) = line.trim().parse::<i32>() else {
                continue;
            };
            if except_pid == Some(pid as u32) {
                continue;
            }
            log::warn!("[DevFleet] stopping orphan process ({pattern}) pid {pid}");
            terminate_process(pid);
        }
    }
    #[cfg(windows)]
    {
        let ps = format!(
            "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{pattern}*' }} | Select-Object -ExpandProperty ProcessId"
        );
        let output = StdCommand::new("powershell")
            .args(["-NoProfile", "-Command", &ps])
            .output();
        if let Ok(output) = output {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let Ok(pid) = line.trim().parse::<i32>() else {
                    continue;
                };
                if except_pid == Some(pid as u32) {
                    continue;
                }
                log::warn!("[DevFleet] stopping orphan process ({pattern}) pid {pid}");
                terminate_process(pid);
            }
        }
    }
}

fn validate_embedded_bundle(server_dir: &Path) -> Result<(), String> {
    if !server_dir.join("devfleet-server.cjs").is_file() {
        return Err(format!(
            "缺少 {}",
            server_dir.join("devfleet-server.cjs").display()
        ));
    }
    if resolve_bundled_node(server_dir).is_none() {
        return Err(format!(
            "安装包缺少 bundled Node：{}",
            server_dir.join("runtime").display()
        ));
    }
    for rel in [
        "node_modules/better-sqlite3",
        "node_modules/bindings",
        "node_modules/file-uri-to-path",
    ] {
        let path = server_dir.join(rel);
        if !path.exists() {
            return Err(format!("安装包缺少 {}", path.display()));
        }
    }
    Ok(())
}

fn resolve_embedded_node(server_dir: &Path) -> Result<String, String> {
    if let Some(bundled) = resolve_bundled_node(server_dir) {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        if let Some(node) = resolve_node_executable() {
            log::warn!("[DevFleet] dev mode: using system node {node}");
            return Ok(node);
        }
    }
    Err(format!(
        "未找到 bundled Node（{}）。请重新安装排比 Para",
        server_dir.join("runtime").display()
    ))
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
    let tail: String = raw
        .lines()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if !tail.is_empty() {
        log::warn!("[DevFleet] embedded server log tail:\n{tail}");
    }
}

fn start_embedded_server(app: &AppHandle) -> Result<Child, String> {
    let script = resolve_server_script(app).ok_or_else(|| macos_resource_install_hint(app))?;
    let server_dir = script.parent().ok_or("无效 server 目录")?.to_path_buf();
    validate_embedded_bundle(&server_dir)?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_file = data_dir.join("devfleet.db");
    let node_modules = server_dir.join("node_modules");
    let node = resolve_embedded_node(&server_dir)?;
    log::info!("[DevFleet] embedded server db: {}", db_file.display());
    log::info!("[DevFleet] embedded server node: {node}");

    let mut command = StdCommand::new(&node);
    if let Some(log_file) = open_server_log(&data_dir) {
        if let Ok(stdout) = log_file.try_clone() {
            command.stdout(Stdio::from(stdout));
        }
        command.stderr(Stdio::from(log_file));
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }
    configure_embedded_server_command(&mut command);
    command
        .current_dir(&server_dir)
        .arg(&script)
        .env_clear()
        .env("PORT", "3001")
        .env("DEVFLEET_HOST", "0.0.0.0")
        .env("DEVFLEET_DESKTOP", "1")
        .env("DEVFLEET_DATA_DIR", data_dir.to_string_lossy().into_owned())
        .env("DEVFLEET_DB_FILE", db_file.to_string_lossy().into_owned())
        .env("NODE_PATH", node_modules.to_string_lossy().into_owned());

    command
        .spawn()
        .map_err(|error| {
            let msg = format!("spawn 失败: {error}");
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(data_dir.join("devfleet-server.log"))
            {
                let _ = writeln!(file, "[DevFleet] {msg}");
            }
            msg
        })
        .inspect(|_| {
            log::info!(
                "[DevFleet] starting embedded API server on http://0.0.0.0:3001 (LAN enabled)"
            );
        })
}

fn resolve_server_script(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let dev =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist-server/devfleet-server.cjs");
        if dev.is_file() {
            log::info!("[DevFleet] using dev server bundle: {}", dev.display());
            return Some(dev);
        }
    }
    if let Some(path) = resolve_bundled_resource(app, "server/devfleet-server.cjs") {
        return Some(path);
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_resource_install_hint(_app: &AppHandle) -> String {
    "未找到 server/devfleet-server.cjs。请先从 DMG 将 PaibiPara 拖到「应用程序」，在终端执行 xattr -cr /Applications/PaibiPara.app 后重新打开（不要从 DMG 或「下载」直接运行）。".into()
}

#[cfg(not(target_os = "macos"))]
fn macos_resource_install_hint(_app: &AppHandle) -> String {
    "未找到 server/devfleet-server.cjs。请重新安装排比 Para 桌面客户端。".into()
}
