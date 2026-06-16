use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

const SERVER_NAME: &str = "devfleet";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientStatus {
    tool: String,
    installed: bool,
    configured: bool,
    matches_current: bool,
    state: String,
    detail: Option<String>,
}

struct McpOptions<'a> {
    mcp_path: &'a str,
    api_url: &'a str,
    token: &'a str,
}

#[tauri::command]
pub fn ensure_mcp_bundle(app: AppHandle) -> Result<String, String> {
    let dest_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("mcp");
    let dest = dest_dir.join("devfleet-mcp.mjs");
    if dest.is_file() {
        return Ok(dest.display().to_string());
    }
    let src = app
        .path()
        .resolve("mcp/devfleet-mcp.mjs", tauri::path::BaseDirectory::Resource)
        .map_err(|error| error.to_string())?;
    if !src.is_file() {
        return Err("内置 MCP 文件缺失，请从 Release 下载 devfleet-mcp.zip".into());
    }
    std::fs::create_dir_all(&dest_dir).map_err(|error| error.to_string())?;
    std::fs::copy(&src, &dest).map_err(|error| error.to_string())?;
    Ok(dest.display().to_string())
}

fn resolve_mcp_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if !trimmed.is_empty() && Path::new(trimmed).is_file() {
        return Ok(trimmed.to_string());
    }
    Err("MCP 文件不存在。桌面端会自动解压到应用数据目录，请刷新页面或重新打开 DevFleet。".into())
}

#[tauri::command]
pub fn mcp_client_statuses(
    mcp_path: String,
    api_url: String,
    token: String,
) -> Vec<McpClientStatus> {
    let options = McpOptions {
        mcp_path: mcp_path.trim(),
        api_url: api_url.trim().trim_end_matches('/'),
        token: token.trim(),
    };

    ["trae", "codex", "cursor", "claude_code"]
        .into_iter()
        .map(|tool| inspect_client(tool, &options))
        .collect()
}

#[tauri::command]
pub fn install_mcp_client(
    tool: String,
    mcp_path: String,
    api_url: String,
    token: String,
) -> Result<McpClientStatus, String> {
    let tool = tool.trim();
    if !matches!(tool, "trae" | "codex" | "cursor" | "claude_code") {
        return Err("不支持的 MCP 客户端".into());
    }

    let mcp_path = resolve_mcp_path(&mcp_path)?;
    let api_url = api_url.trim().trim_end_matches('/');
    if !(api_url.starts_with("http://") || api_url.starts_with("https://")) {
        return Err("MCP API 地址必须以 http:// 或 https:// 开头".into());
    }

    let options = McpOptions {
        mcp_path: mcp_path.as_str(),
        api_url,
        token: token.trim(),
    };
    let node = find_node_executable()
        .ok_or_else(|| "未检测到 Node.js，请先安装 Node.js 20.19+（或安装 Cursor / VS Code 等自带 Node 的 IDE）".to_string())?;

    match tool {
        "codex" => install_codex(&options, &node)?,
        "claude_code" => install_claude(&options, &node)?,
        "cursor" => {
            if !client_installed(tool) {
                return Err(format!("未检测到 {}，请先安装客户端", tool_label(tool)));
            }
            let path = preferred_json_config_path(tool, None)?;
            merge_json_config(&path, &json_server_config(&options, &node))?;
        }
        "trae" => {
            if !client_installed(tool) {
                return Err(format!("未检测到 {}，请先安装客户端", tool_label(tool)));
            }
            let variant = detect_trae_variant();
            let path = preferred_json_config_path(tool, Some(variant.as_str()))?;
            merge_json_config(&path, &json_server_config(&options, &node))?;
        }
        _ => unreachable!(),
    }

    let status = inspect_client(tool, &options);
    if !status.configured {
        return Err(format!(
            "{} 配置已写入，但未能复检到 DevFleet MCP（{}）",
            tool_label(tool),
            status.detail.unwrap_or_else(|| "请重启客户端后重试".into())
        ));
    }
    Ok(status)
}

/// 保留给旧前端的 Trae 专用命令，实际复用统一安装与复检逻辑。
#[tauri::command]
pub fn install_trae_mcp(
    mcp_path: String,
    api_url: String,
    token: String,
) -> Result<String, String> {
    let status = install_mcp_client("trae".into(), mcp_path, api_url, token)?;
    Ok(status
        .detail
        .map(|path| format!("Trae MCP 配置已写入 {path}"))
        .unwrap_or_else(|| "Trae MCP 配置已完成".into()))
}

/// 检测本机安装的 Trae 版本
#[tauri::command]
pub fn detect_trae_variant() -> String {
    if app_exists("TRAE SOLO CN") || app_exists("Trae CN") {
        return "cn".into();
    }
    if app_exists("TRAE SOLO") || app_exists("Trae") {
        return "intl".into();
    }
    // 通过 Application Support 目录判断版本
    if let Some(home) = home_dir() {
        let cn_dirs = [
            home.join("Library/Application Support/TRAE SOLO CN"),
            home.join("Library/Application Support/Trae CN"),
        ];
        let intl_dirs = [
            home.join("Library/Application Support/TRAE SOLO"),
            home.join("Library/Application Support/Trae"),
        ];
        if cn_dirs.iter().any(|p| p.is_dir()) {
            return "cn".into();
        }
        if intl_dirs.iter().any(|p| p.is_dir()) {
            return "intl".into();
        }
    }
    "cn".into()
}

fn inspect_client(tool: &str, options: &McpOptions<'_>) -> McpClientStatus {
    let installed = client_installed(tool);
    let result = match tool {
        "codex" => inspect_codex(options),
        "claude_code" => inspect_json_paths(tool, options),
        "cursor" | "trae" => inspect_json_paths(tool, options),
        _ => Ok(None),
    };

    match result {
        Ok(Some((matches_current, detail))) => McpClientStatus {
            tool: tool.to_string(),
            installed,
            configured: true,
            matches_current,
            state: if matches_current {
                "configured"
            } else {
                "needs_update"
            }
            .into(),
            detail: Some(detail),
        },
        Ok(None) => McpClientStatus {
            tool: tool.to_string(),
            installed,
            configured: false,
            matches_current: false,
            state: if installed {
                "not_configured"
            } else {
                "not_installed"
            }
            .into(),
            detail: None,
        },
        Err(error) => McpClientStatus {
            tool: tool.to_string(),
            installed,
            configured: false,
            matches_current: false,
            state: "error".into(),
            detail: Some(error),
        },
    }
}

fn inspect_codex(options: &McpOptions<'_>) -> Result<Option<(bool, String)>, String> {
    let Some(codex) = find_client_executable("codex") else {
        return Ok(None);
    };
    let output = Command::new(&codex)
        .args(["mcp", "get", SERVER_NAME, "--json"])
        .output()
        .map_err(|error| format!("Codex 配置检测失败: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Codex 配置解析失败: {error}"))?;
    Ok(Some((
        config_matches(&value, options),
        "Codex 用户配置".into(),
    )))
}

fn inspect_json_paths(
    tool: &str,
    options: &McpOptions<'_>,
) -> Result<Option<(bool, String)>, String> {
    let variant = if tool == "trae" {
        Some(detect_trae_variant())
    } else {
        None
    };
    for path in json_config_paths(tool, variant.as_deref()) {
        if !path.is_file() {
            continue;
        }
        let raw = std::fs::read_to_string(&path)
            .map_err(|error| format!("无法读取 {}: {error}", path.display()))?;
        let root: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("{} 不是有效 JSON: {error}", path.display()))?;
        if let Some(config) = root
            .get("mcpServers")
            .and_then(|servers| servers.get(SERVER_NAME))
        {
            return Ok(Some((
                config_matches(config, options),
                path.display().to_string(),
            )));
        }
    }
    Ok(None)
}

fn install_codex(options: &McpOptions<'_>, node: &str) -> Result<(), String> {
    let codex = find_client_executable("codex")
        .ok_or_else(|| "未检测到 Codex CLI，请先安装或登录 Codex".to_string())?;
    let current = Command::new(&codex)
        .args(["mcp", "get", SERVER_NAME, "--json"])
        .output()
        .map_err(|error| format!("Codex 配置检测失败: {error}"))?;
    if current.status.success() {
        let _ = Command::new(&codex)
            .args(["mcp", "remove", SERVER_NAME])
            .output();
    }

    let output = Command::new(&codex)
        .args([
            "mcp",
            "add",
            SERVER_NAME,
            "--env",
            &format!("DEVFLEET_API_URL={}", options.api_url),
            "--env",
            &format!("DEVFLEET_TOKEN={}", options.token),
            "--",
            node,
            options.mcp_path,
        ])
        .output()
        .map_err(|error| format!("无法执行 Codex CLI: {error}"))?;
    command_result("Codex", output)
}

fn json_server_config(options: &McpOptions<'_>, node: &str) -> Value {
    json!({
        "command": node,
        "args": [options.mcp_path],
        "env": {
            "DEVFLEET_API_URL": options.api_url,
            "DEVFLEET_TOKEN": options.token,
        }
    })
}

fn install_claude(options: &McpOptions<'_>, node: &str) -> Result<(), String> {
    let claude = find_client_executable("claude_code")
        .ok_or_else(|| "未检测到 Claude Code CLI，请先安装 Claude Code".to_string())?;
    let config = json_server_config(options, node).to_string();
    let _ = Command::new(&claude)
        .args(["mcp", "remove", SERVER_NAME, "--scope", "user"])
        .output();
    let output = Command::new(&claude)
        .args(["mcp", "add-json", SERVER_NAME, &config, "--scope", "user"])
        .output()
        .map_err(|error| format!("无法执行 Claude Code CLI: {error}"))?;
    command_result("Claude Code", output)
}

fn command_result(label: &str, output: std::process::Output) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    Err(if detail.is_empty() {
        format!(
            "{label} 配置失败，退出码 {}",
            output.status.code().unwrap_or(-1)
        )
    } else {
        format!("{label} 配置失败: {detail}")
    })
}

fn config_matches(config: &Value, options: &McpOptions<'_>) -> bool {
    let config = config.get("transport").unwrap_or(config);
    let command = config
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let node_ok = command.ends_with("node")
        || Path::new(command)
            .file_stem()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("node"))
            .unwrap_or(false);
    let path_ok = config
        .get("args")
        .and_then(Value::as_array)
        .and_then(|args| args.first())
        .and_then(Value::as_str)
        == Some(options.mcp_path);
    let env = config.get("env").and_then(Value::as_object);
    let api_ok = env
        .and_then(|value| value.get("DEVFLEET_API_URL"))
        .and_then(Value::as_str)
        .map(|value| value.trim_end_matches('/') == options.api_url)
        .unwrap_or(false);
    let token_ok = env
        .and_then(|value| value.get("DEVFLEET_TOKEN"))
        .and_then(Value::as_str)
        == Some(options.token);
    node_ok && path_ok && api_ok && token_ok
}

fn merge_json_config(path: &Path, server: &Value) -> Result<(), String> {
    let mut root = if path.is_file() {
        let raw = std::fs::read_to_string(path)
            .map_err(|error| format!("无法读取 {}: {error}", path.display()))?;
        serde_json::from_str::<Value>(&raw)
            .map_err(|error| format!("{} 不是有效 JSON: {error}", path.display()))?
    } else {
        json!({})
    };

    let root_object = root
        .as_object_mut()
        .ok_or_else(|| format!("{} 的根节点必须是 JSON 对象", path.display()))?;
    let servers = root_object
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| format!("{} 的 mcpServers 必须是 JSON 对象", path.display()))?;
    servers.insert(SERVER_NAME.into(), server.clone());

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 {}: {error}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?;
    std::fs::write(path, format!("{raw}\n"))
        .map_err(|error| format!("无法写入 {}: {error}", path.display()))
}

fn preferred_json_config_path(tool: &str, trae_variant: Option<&str>) -> Result<PathBuf, String> {
    let paths = json_config_paths(tool, trae_variant);
    paths
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .or_else(|| paths.into_iter().next())
        .ok_or_else(|| format!("无法确定 {} 配置目录", tool_label(tool)))
}

fn json_config_paths(tool: &str, trae_variant: Option<&str>) -> Vec<PathBuf> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    match tool {
        "cursor" => {
            let mut paths = vec![home.join(".cursor").join("mcp.json")];
            #[cfg(target_os = "macos")]
            paths.push(home.join("Library/Application Support/Cursor/User/mcp.json"));
            #[cfg(target_os = "linux")]
            paths.push(home.join(".config/Cursor/User/mcp.json"));
            #[cfg(target_os = "windows")]
            if let Some(app_data) = std::env::var_os("APPDATA") {
                paths.push(PathBuf::from(app_data).join("Cursor/User/mcp.json"));
            }
            paths
        }
        "trae" => {
            let variant = trae_variant.unwrap_or("cn");
            let mut paths = Vec::new();
            #[cfg(target_os = "macos")]
            {
                if variant == "cn" {
                    paths.push(home.join("Library/Application Support/Trae CN/User/mcp.json"));
                    paths.push(home.join("Library/Application Support/TRAE SOLO CN/User/mcp.json"));
                } else {
                    paths.push(home.join("Library/Application Support/Trae/User/mcp.json"));
                    paths.push(home.join("Library/Application Support/TRAE SOLO/User/mcp.json"));
                }
                paths.push(home.join("Library/Application Support/Trae/mcp.json"));
            }
            #[cfg(target_os = "linux")]
            {
                if variant == "cn" {
                    paths.push(home.join(".config/Trae CN/User/mcp.json"));
                } else {
                    paths.push(home.join(".config/Trae/User/mcp.json"));
                }
            }
            #[cfg(target_os = "windows")]
            if let Some(app_data) = std::env::var_os("APPDATA") {
                let base = PathBuf::from(app_data);
                if variant == "cn" {
                    paths.push(base.join("Trae CN/User/mcp.json"));
                } else {
                    paths.push(base.join("Trae/User/mcp.json"));
                }
            }
            paths.push(home.join(".trae/mcp.json"));
            paths.dedup();
            paths
        }
        "claude_code" => vec![home.join(".claude.json")],
        _ => Vec::new(),
    }
}

fn client_installed(tool: &str) -> bool {
    find_client_executable(tool).is_some()
        || match tool {
            "trae" => {
                app_exists("Trae")
                    || app_exists("Trae CN")
                    || app_exists("TRAE SOLO CN")
                    || app_exists("TRAE SOLO")
                    || trae_support_dir_exists()
            }
            "cursor" => app_exists("Cursor"),
            "codex" => app_exists("Codex"),
            "claude_code" => app_exists("Claude"),
            _ => false,
        }
}

fn find_client_executable(tool: &str) -> Option<String> {
    let binary = match tool {
        "claude_code" => "claude",
        other => other,
    };
    if let Some(path) = find_executable(binary) {
        return Some(path);
    }
    #[cfg(target_os = "macos")]
    {
        let candidates: &[&str] = match tool {
            "codex" => &[
                "/Applications/Codex.app/Contents/Resources/codex",
                "/Applications/Codex.app/Contents/MacOS/Codex",
            ],
            "claude_code" => &["/Applications/Claude.app/Contents/MacOS/Claude"],
            "cursor" => &["/Applications/Cursor.app/Contents/MacOS/Cursor"],
            "trae" => &[
                "/Applications/Trae.app/Contents/MacOS/Trae",
                "/Applications/Trae CN.app/Contents/MacOS/Trae CN",
                "/Applications/TRAE SOLO CN.app/Contents/MacOS/TRAE SOLO CN",
                "/Applications/TRAE SOLO.app/Contents/MacOS/TRAE SOLO",
                "/Volumes/Trae CN/Trae CN.app/Contents/MacOS/Electron",
                "/Volumes/TRAE Work CN/TRAE SOLO CN.app/Contents/MacOS/Electron",
                "/Volumes/TRAE Work/TRAE SOLO.app/Contents/MacOS/Electron",
            ],
            _ => &[],
        };
        return candidates
            .iter()
            .find(|path| Path::new(path).is_file())
            .map(|path| path.to_string());
    }
    #[allow(unreachable_code)]
    None
}

fn find_node_executable() -> Option<String> {
    if let Some(path) = find_executable("node") {
        return Some(path);
    }

    #[cfg(target_os = "macos")]
    {
        let bundled = [
            "/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node",
            "/Applications/Visual Studio Code.app/Contents/Resources/app/resources/helpers/node",
            "/Applications/Trae.app/Contents/Resources/app/resources/helpers/node",
            "/Applications/Trae CN.app/Contents/Resources/app/resources/helpers/node",
            "/Applications/TRAE SOLO.app/Contents/Resources/app/resources/helpers/node",
            "/Applications/TRAE SOLO CN.app/Contents/Resources/app/resources/helpers/node",
            "/Volumes/Trae CN/Trae CN.app/Contents/Resources/app/resources/helpers/node",
        ];
        return bundled
            .iter()
            .find(|path| Path::new(path).is_file())
            .map(|path| path.to_string());
    }

    #[allow(unreachable_code)]
    None
}

fn find_executable(binary: &str) -> Option<String> {
    for prefix in executable_search_dirs() {
        let path = Path::new(&prefix).join(binary);
        if path.is_file() {
            return Some(path.display().to_string());
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = Command::new("which")
            .arg(binary)
            .env("PATH", expanded_path())
            .output()
        {
            if output.status.success() {
                if let Some(path) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let path = path.trim();
                    if !path.is_empty() {
                        return Some(path.to_string());
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = Command::new("where").arg(binary).output() {
            if output.status.success() {
                if let Some(path) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let path = path.trim();
                    if !path.is_empty() {
                        return Some(path.to_string());
                    }
                }
            }
        }
    }

    None
}

fn expanded_path() -> String {
    format!(
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
        std::env::var("PATH").unwrap_or_default()
    )
}

fn executable_search_dirs() -> Vec<String> {
    let mut dirs = vec![
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
    ];
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local/bin").display().to_string());
    }
    dirs
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn app_exists(name: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        // 检查 /Applications 目录
        if Path::new(&format!("/Applications/{name}.app")).is_dir() {
            return true;
        }
        // 检查 /Volumes 下的 DMG 挂载安装
        if let Ok(entries) = std::fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                let app_path = entry.path().join(format!("{name}.app"));
                if app_path.is_dir() {
                    return true;
                }
            }
        }
        return false;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = name;
        false
    }
}

/// 检查 Trae 的 Application Support 目录是否存在（作为安装检测的回退）
fn trae_support_dir_exists() -> bool {
    if let Some(home) = home_dir() {
        let candidates = [
            home.join("Library/Application Support/Trae CN"),
            home.join("Library/Application Support/Trae"),
            home.join("Library/Application Support/TRAE SOLO CN"),
            home.join("Library/Application Support/TRAE SOLO"),
        ];
        return candidates.iter().any(|p| p.is_dir());
    }
    false
}

fn tool_label(tool: &str) -> &str {
    match tool {
        "trae" => "Trae",
        "codex" => "Codex",
        "cursor" => "Cursor",
        "claude_code" => "Claude Code",
        _ => tool,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_existing_servers() {
        let dir = std::env::temp_dir().join(format!("devfleet-mcp-{}", std::process::id()));
        let path = dir.join("mcp.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            r#"{"mcpServers":{"existing":{"url":"https://example.com"}}}"#,
        )
        .unwrap();
        let server = json!({"command":"node","args":["/tmp/devfleet.mjs"],"env":{}});

        merge_json_config(&path, &server).unwrap();

        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(value["mcpServers"]["existing"].is_object());
        assert_eq!(value["mcpServers"][SERVER_NAME], server);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn matching_config_ignores_node_absolute_path() {
        let options = McpOptions {
            mcp_path: "/tmp/devfleet.mjs",
            api_url: "http://localhost:3001",
            token: "secret",
        };
        let config = json!({
            "command": "/usr/local/bin/node",
            "args": ["/tmp/devfleet.mjs"],
            "env": {
                "DEVFLEET_API_URL": "http://localhost:3001/",
                "DEVFLEET_TOKEN": "secret"
            }
        });
        assert!(config_matches(&config, &options));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn finds_cursor_bundled_node() {
        let cursor_node = "/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node";
        if !Path::new(cursor_node).is_file() {
            return;
        }
        let node = find_node_executable().expect("expected bundled node fallback");
        assert!(node.ends_with("node"));
    }

    #[test]
    #[ignore = "live smoke: cargo test live_cursor_install_smoke -- --ignored --nocapture"]
    fn live_cursor_install_smoke() {
        let Some(home) = home_dir() else {
            return;
        };
        let mcp_path =
            home.join("Library/Application Support/com.devfleet.desktop/mcp/devfleet-mcp.mjs");
        assert!(
            mcp_path.is_file(),
            "launch DevFleet once so MCP bundle is extracted"
        );
        let token = std::env::var("DEVFLEET_TOKEN").unwrap_or_default();
        let api_url =
            std::env::var("DEVFLEET_API_URL").unwrap_or_else(|_| "http://localhost:3001".into());
        let options = McpOptions {
            mcp_path: mcp_path.to_str().unwrap(),
            api_url: api_url.trim_end_matches('/'),
            token: token.as_str(),
        };
        let node = find_node_executable().expect("node required for MCP install");
        let path = preferred_json_config_path("cursor", None).expect("cursor config path");
        let backup = path.with_extension("json.bak.smoke");
        if path.is_file() {
            std::fs::copy(&path, &backup).unwrap();
        }
        merge_json_config(&path, &json_server_config(&options, &node)).unwrap();
        let status = inspect_client("cursor", &options);
        assert!(
            status.configured && status.matches_current,
            "cursor install smoke failed: {:?}",
            status
        );
        if backup.is_file() {
            std::fs::copy(&backup, &path).unwrap();
            let _ = std::fs::remove_file(backup);
        } else if path.is_file() {
            let _ = std::fs::remove_file(path);
        }
    }
}
