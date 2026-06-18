use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::{AppHandle, Manager};
use url::Url;

const MIN_SQLITE_NODE_MODULES: u32 = 127;
const DEFAULT_NO_PROXY_ENTRIES: &[&str] = &[
    "localhost",
    "127.0.0.1",
    "::1",
    ".local",
    "*.local",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "fc00::/7",
    "fe80::/10",
];

/// 解析 Tauri 打包资源；macOS 从 DMG/下载目录直接打开时 PathResolver 可能失败，回退到 exe 旁 Resources。
pub fn resolve_bundled_resource(app: &AppHandle, relative: &str) -> Option<PathBuf> {
    if let Ok(path) = app
        .path()
        .resolve(relative, tauri::path::BaseDirectory::Resource)
    {
        if path.is_file() {
            return Some(path);
        }
    }

    if let Ok(dir) = app.path().resource_dir() {
        let path = dir.join(relative);
        if path.is_file() {
            return Some(path);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        #[cfg(target_os = "macos")]
        if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
            let path = contents.join("Resources").join(relative);
            if path.is_file() {
                return Some(path);
            }
        }

        #[cfg(target_os = "windows")]
        if let Some(exe_dir) = exe.parent() {
            let path = exe_dir.join(relative);
            if path.is_file() {
                return Some(path);
            }
        }

        #[cfg(target_os = "linux")]
        if let Some(exe_dir) = exe.parent() {
            for candidate in [
                exe_dir.join(relative),
                exe_dir.join("../lib").join(relative),
            ] {
                if let Ok(path) = candidate.canonicalize() {
                    if path.is_file() {
                        return Some(path);
                    }
                }
            }
        }
    }

    None
}

/// App 内嵌 Node 运行时（与 better-sqlite3 编译 ABI 一致），优先于本机 Node。
pub fn resolve_bundled_node(server_dir: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let node = server_dir.join("runtime").join("node.exe");
        return node.is_file().then(|| node.display().to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let node = server_dir.join("runtime").join("bin").join("node");
        return node.is_file().then(|| node.display().to_string());
    }
}

/// 解析本机 Node，优先 ABI 与 better-sqlite3 原生模块匹配（Node 22+ / modules 127+）。
pub fn resolve_node_executable() -> Option<String> {
    let mut candidates = collect_node_candidates();
    candidates.sort();
    candidates.dedup();

    let mut best: Option<(u32, String)> = None;
    for path in candidates {
        if !Path::new(&path).is_file() {
            continue;
        }
        let Some(modules) = node_module_version(&path) else {
            continue;
        };
        let replace = match &best {
            None => true,
            Some((best_modules, _)) => modules > *best_modules,
        };
        if replace {
            best = Some((modules, path));
        }
    }

    if let Some((modules, path)) = best {
        if modules >= MIN_SQLITE_NODE_MODULES {
            return Some(path);
        }
        log::warn!(
            "[DevFleet] node {} ABI modules={modules} < {MIN_SQLITE_NODE_MODULES}; better-sqlite3 may fail",
            path
        );
        return Some(path);
    }

    which_executable("node")
}

fn collect_node_candidates() -> Vec<String> {
    let mut candidates: Vec<String> = vec![
        "/opt/homebrew/bin/node".into(),
        "/usr/local/bin/node".into(),
    ];

    if let Some(home) = std::env::var_os("HOME") {
        let home = Path::new(&home);
        candidates.push(home.join(".local/bin/node").display().to_string());
    }

    #[cfg(target_os = "macos")]
    {
        candidates.extend(macos_embedded_node_paths());
    }

    if let Some(path) = which_executable("node") {
        candidates.push(path);
    }

    candidates
}

#[cfg(target_os = "macos")]
fn macos_embedded_node_paths() -> Vec<String> {
    let mut paths = vec![
        "/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node".into(),
        "/Applications/Visual Studio Code.app/Contents/Resources/app/resources/helpers/node".into(),
        "/Applications/Trae CN.app/Contents/Resources/app/resources/helpers/node".into(),
        "/Applications/Trae.app/Contents/Resources/app/resources/helpers/node".into(),
    ];

    if let Ok(entries) = fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let volume = entry.path();
            for app in ["Cursor.app", "Trae CN.app", "Trae.app"] {
                let node = volume
                    .join(app)
                    .join("Contents/Resources/app/resources/helpers/node");
                if node.is_file() {
                    paths.push(node.display().to_string());
                }
                if let Ok(children) = fs::read_dir(&volume) {
                    for child in children.flatten() {
                        let nested = child
                            .path()
                            .join(app)
                            .join("Contents/Resources/app/resources/helpers/node");
                        if nested.is_file() {
                            paths.push(nested.display().to_string());
                        }
                    }
                }
            }
        }
    }

    paths
}

fn node_module_version(node_path: &str) -> Option<u32> {
    let output = Command::new(node_path)
        .arg("-pe")
        .arg("process.versions.modules")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

fn which_executable(binary: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("where").arg(binary).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()?
            .trim()
            .to_string();
        return (!path.is_empty()).then_some(path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("which")
            .arg(binary)
            .env(
                "PATH",
                format!(
                    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!path.is_empty()).then_some(path)
    }
}

/// 内嵌 API 子进程：无 setsid，随 DevFleet 主进程退出；不弹 Terminal。
pub fn configure_embedded_server_command(command: &mut Command) {
    command.stdin(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn merge_no_proxy_entries<'a>(extra_entries: impl IntoIterator<Item = &'a str>) -> String {
    let mut entries: Vec<String> = ["NO_PROXY", "no_proxy"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .flat_map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect();

    for entry in DEFAULT_NO_PROXY_ENTRIES
        .iter()
        .copied()
        .chain(extra_entries)
    {
        append_unique_no_proxy(&mut entries, entry);
    }

    entries.join(",")
}

fn append_unique_no_proxy(entries: &mut Vec<String>, entry: &str) {
    let entry = entry.trim();
    if entry.is_empty() {
        return;
    }
    if !entries
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(entry))
    {
        entries.push(entry.to_string());
    }
}

pub fn lan_no_proxy_hosts_from_values(values: &[&str]) -> Vec<String> {
    let mut hosts = Vec::new();
    for raw in values {
        let Some(host) = host_from_connection_value(raw) else {
            continue;
        };
        if is_lan_no_proxy_host(&host) && !hosts.iter().any(|item| item == &host) {
            hosts.push(host);
        }
    }
    hosts
}

fn host_from_connection_value(raw: &str) -> Option<String> {
    let token = raw.trim().trim_matches(|ch: char| {
        ch == '"' || ch == '\'' || ch == '<' || ch == '>' || ch == '(' || ch == ')'
    });
    if token.starts_with("git@") {
        return token
            .strip_prefix("git@")
            .and_then(|value| value.split(':').next())
            .map(str::to_string);
    }
    Url::parse(token)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
}

fn is_lan_no_proxy_host(host: &str) -> bool {
    let host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if host == "localhost" || host.ends_with(".local") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local(),
        Err(_) => false,
    }
}

/// 其他后台子进程（仍隐藏窗口；Unix 下 setsid 与主进程分离）。
pub fn configure_hidden_command(command: &mut Command) {
    command.stdin(Stdio::null()).stdout(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_prefers_higher_module_version() {
        let node = resolve_node_executable();
        if let Some(path) = node {
            let modules = node_module_version(&path).unwrap_or(0);
            assert!(modules > 0, "node at {path} should report modules version");
        }
    }

    #[test]
    fn no_proxy_defaults_include_private_networks() {
        let value = merge_no_proxy_entries(std::iter::empty::<&str>());
        assert!(value.contains("192.168.0.0/16"));
        assert!(value.contains("10.0.0.0/8"));
        assert!(value.contains("localhost"));
    }

    #[test]
    fn extracts_lan_hosts_from_urls() {
        let hosts = lan_no_proxy_hosts_from_values(&[
            "http://192.168.0.38:3001/api/health",
            "https://example.com",
            "git@10.0.0.5:org/repo.git",
        ]);
        assert_eq!(hosts, vec!["192.168.0.38", "10.0.0.5"]);
    }
}
