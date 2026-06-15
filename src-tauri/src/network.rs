use std::net::UdpSocket;
use std::path::Path;
use std::process::Command as StdCommand;

fn is_allowed_external_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("cursor://")
        || lower.starts_with("trae://")
        || lower.starts_with("trae-cn://")
}

fn app_installed(name: &str) -> bool {
    // 检查 /Applications 目录
    if Path::new(&format!("/Applications/{name}.app")).exists() {
        return true;
    }
    // 检查 /Volumes 下的 DMG 挂载安装
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let app_path = entry.path().join(format!("{name}.app"));
            if app_path.exists() {
                return true;
            }
        }
    }
    false
}

fn open_with_status(args: &[&str]) -> Result<(), String> {
    let status = StdCommand::new("/usr/bin/open")
        .args(args)
        .status()
        .map_err(|e| format!("无法调用系统 open 命令: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "系统无法打开链接（退出码 {}）",
            status.code().unwrap_or(-1)
        ))
    }
}

#[cfg(target_os = "macos")]
fn open_on_macos(url: &str) -> Result<(), String> {
    if url.starts_with("trae-cn://") {
        // 优先 TRAE SOLO CN，其次 Trae CN
        if app_installed("TRAE SOLO CN") {
            return open_with_app_dir("TRAE SOLO CN", url);
        }
        if app_installed("Trae CN") {
            return open_with_status(&["-a", "Trae CN", url]);
        }
        return Err("未检测到 Trae CN，请先安装 Trae 或使用「复制」手动配置 MCP".into());
    }
    if url.starts_with("trae://") {
        if app_installed("TRAE SOLO") {
            return open_with_app_dir("TRAE SOLO", url);
        }
        if app_installed("Trae") {
            return open_with_status(&["-a", "Trae", url]);
        }
        // 国际版未安装但国内版已安装时，尝试用国内版打开
        if app_installed("TRAE SOLO CN") {
            let cn_url = url.replacen("trae://", "trae-cn://", 1);
            return open_with_app_dir("TRAE SOLO CN", &cn_url);
        }
        if app_installed("Trae CN") {
            let cn_url = url.replacen("trae://", "trae-cn://", 1);
            return open_with_status(&["-a", "Trae CN", &cn_url]);
        }
        return Err("未检测到 Trae，请先安装 Trae 或使用「复制」手动配置 MCP".into());
    }
    if url.starts_with("cursor://") {
        if app_installed("Cursor") {
            return open_with_status(&["-a", "Cursor", url]);
        }
        return Err("未检测到 Cursor，请先安装 Cursor 或使用「复制」手动配置 MCP".into());
    }
    open_with_status(&[url])
}

/// 通过应用目录查找并打开 DMG 挂载安装的 Trae 应用
#[cfg(target_os = "macos")]
fn open_with_app_dir(name: &str, url: &str) -> Result<(), String> {
    // 先尝试 /Applications
    let app_path = format!("/Applications/{name}.app");
    if Path::new(&app_path).is_dir() {
        return open_with_status(&["-a", name, url]);
    }
    // 在 /Volumes 下查找
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let candidate = entry.path().join(format!("{name}.app"));
            if candidate.is_dir() {
                // 使用 open 命令直接指定 .app 路径
                return open_with_status(&[&candidate.to_string_lossy(), url]);
            }
        }
    }
    Err(format!("无法找到 {name} 应用路径"))
}

#[cfg(target_os = "windows")]
fn open_on_windows(url: &str) -> Result<(), String> {
    let status = StdCommand::new("cmd")
        .args(["/C", "start", "", url])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "系统无法打开链接（退出码 {}）",
            status.code().unwrap_or(-1)
        ))
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn open_on_linux(url: &str) -> Result<(), String> {
    let status = StdCommand::new("xdg-open")
        .arg(url)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "系统无法打开链接（退出码 {}）",
            status.code().unwrap_or(-1)
        ))
    }
}

pub fn open_external_url_impl(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("链接不能为空".into());
    }
    if !is_allowed_external_url(trimmed) {
        return Err("不支持的链接协议".into());
    }

    #[cfg(target_os = "macos")]
    return open_on_macos(trimmed);
    #[cfg(target_os = "windows")]
    return open_on_windows(trimmed);
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    return open_on_linux(trimmed);
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    open_external_url_impl(&url)
}

#[tauri::command]
pub fn open_trae_install(deeplink_cn: String, deeplink_intl: String) -> Result<String, String> {
    // 优先 TRAE SOLO CN
    if app_installed("TRAE SOLO CN") {
        open_with_app_dir("TRAE SOLO CN", &deeplink_cn)?;
        return Ok("TRAE SOLO CN".into());
    }
    if app_installed("Trae CN") {
        open_external_url_impl(&deeplink_cn)?;
        return Ok("Trae CN".into());
    }
    if app_installed("TRAE SOLO") {
        open_with_app_dir("TRAE SOLO", &deeplink_intl)?;
        return Ok("TRAE SOLO".into());
    }
    if app_installed("Trae") {
        open_external_url_impl(&deeplink_intl)?;
        return Ok("Trae".into());
    }
    Err("未检测到 Trae / Trae CN，请先安装 Trae 或使用「复制」手动配置 MCP".into())
}

fn is_internal_webview_host(host: &str) -> bool {
    host == "localhost"
        || host == "127.0.0.1"
        || host == "tauri.localhost"
        || host.ends_with(".localhost")
}

/// 拦截 WebView 导航：deeplink / 外链用系统打开，避免整页 Load failed
pub fn allow_navigation(url: &url::Url) -> bool {
    let scheme = url.scheme();
    match scheme {
        "trae" | "trae-cn" | "cursor" => {
            let _ = open_external_url_impl(url.as_str());
            false
        }
        "http" | "https" => {
            if is_internal_webview_host(url.host_str().unwrap_or("")) {
                true
            } else {
                let _ = open_external_url_impl(url.as_str());
                false
            }
        }
        "tauri" | "ipc" | "file" => true,
        _ => false,
    }
}

#[tauri::command]
pub fn get_lan_address() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() {
        return None;
    }
    Some(ip.to_string())
}
