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
    Path::new(&format!("/Applications/{name}.app")).exists()
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
        if app_installed("Trae CN") {
            return open_with_status(&["-a", "Trae CN", url]);
        }
        return Err("未检测到 Trae CN，请先安装 Trae 或使用「复制」手动配置 MCP".into());
    }
    if url.starts_with("trae://") {
        if app_installed("Trae") {
            return open_with_status(&["-a", "Trae", url]);
        }
        // 国际版未安装但国内版已安装时，尝试用国内版打开
        if app_installed("Trae CN") {
            // 将 trae:// 替换为 trae-cn:// 后用国内版打开
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
    if app_installed("Trae CN") {
        open_external_url_impl(&deeplink_cn)?;
        return Ok("Trae CN".into());
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
