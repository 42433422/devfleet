use std::path::Path;
use std::process::Command;
use serde_json::{json, Value, Map};

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

const SERVER_NAME: &str = "devfleet";

fn find_executable(binary: &str) -> Option<String> {
    let lookup = Command::new("which").arg(binary).output();
    if let Ok(output) = lookup {
        if output.status.success() {
            if let Some(path) = String::from_utf8_lossy(&output.stdout).lines().next() {
                let path = path.trim();
                if !path.is_empty() {
                    return Some(path.to_string());
                }
            }
        }
    }
    None
}

fn json_server_config(mcp_path: &str, api_url: &str, token: &str, node: &str) -> Value {
    json!({
        "command": node,
        "args": [mcp_path],
        "env": {
            "DEVFLEET_API_URL": api_url,
            "DEVFLEET_TOKEN": token,
        }
    })
}

fn merge_json_config(path: &Path, server: &Value) -> Result<(), String> {
    let root = if path.is_file() {
        let raw = std::fs::read_to_string(path)
            .map_err(|error| format!("无法读取 {}: {error}", path.display()))?;
        serde_json::from_str::<Value>(&raw)
            .map_err(|error| format!("{} 不是有效 JSON: {error}", path.display()))?
    } else {
        json!({})
    };

    let mut root_object = root
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} 的根节点必须是 JSON 对象", path.display()))?;
    
    let servers = root_object
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    
    if let Some(servers_map) = servers.as_object_mut() {
        servers_map.insert(SERVER_NAME.into(), server.clone());
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 {}: {error}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(&root_object).map_err(|error| error.to_string())?;
    std::fs::write(path, format!("{raw}\n"))
        .map_err(|error| format!("无法写入 {}: {error}", path.display()))
}

fn json_config_paths() -> Vec<std::path::PathBuf> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    vec![
        home.join("Library/Application Support/TRAE SOLO CN/User/mcp.json"),
        home.join("Library/Application Support/Trae CN/User/mcp.json"),
        home.join("Library/Application Support/TRAE SOLO/User/mcp.json"),
        home.join("Library/Application Support/Trae/User/mcp.json"),
        home.join(".trae/mcp.json"),
    ]
}

fn preferred_json_config_path() -> Result<std::path::PathBuf, String> {
    let paths = json_config_paths();
    paths
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .or_else(|| paths.into_iter().next())
        .ok_or_else(|| "无法确定 Trae 配置目录".into())
}

#[cfg(test)]
mod integration_tests {
    use super::*;

    #[test]
    fn test_trae_full_install_flow() {
        // 1. 检测 Node.js
        let node = find_executable("node").expect("需要 Node.js");

        // 2. 确定配置文件路径
        let config_path = preferred_json_config_path().expect("需要 Trae 配置路径");

        // 3. 构建服务器配置
        let mcp_path = "/Users/Shared/DevFleet/mcp/devfleet-mcp.mjs";
        let api_url = "http://localhost:3001";
        let token = "test-token-for-verification";
        
        let server_config = json_server_config(mcp_path, api_url, token, &node);

        // 4. 写入配置
        merge_json_config(&config_path, &server_config).expect("写入配置失败");

        // 5. 验证配置
        let content = std::fs::read_to_string(&config_path).unwrap();
        let parsed: Value = serde_json::from_str(&content).unwrap();
        
        assert!(parsed["mcpServers"]["devfleet"].is_object(), "devfleet 配置应存在");
        assert_eq!(parsed["mcpServers"]["devfleet"]["command"], node);
        assert_eq!(parsed["mcpServers"]["devfleet"]["args"][0], mcp_path);
        assert_eq!(parsed["mcpServers"]["devfleet"]["env"]["DEVFLEET_API_URL"], api_url);
        assert_eq!(parsed["mcpServers"]["devfleet"]["env"]["DEVFLEET_TOKEN"], token);

        // 6. 清理测试数据
        if let Some(servers) = parsed["mcpServers"].as_object() {
            if servers.len() == 1 && servers.contains_key("devfleet") {
                std::fs::remove_file(&config_path).ok();
            } else {
                let mut cleaned = parsed.clone();
                if let Some(s) = cleaned["mcpServers"].as_object_mut() {
                    s.remove("devfleet");
                }
                let raw = serde_json::to_string_pretty(&cleaned).unwrap();
                std::fs::write(&config_path, format!("{raw}\n")).ok();
            }
        }
    }

    #[test]
    fn test_trae_config_path_detection() {
        let paths = json_config_paths();
        assert!(!paths.is_empty(), "应至少有一个配置路径候选");
        
        // 第一个路径应该是 TRAE SOLO CN
        let first = paths[0].to_string_lossy();
        assert!(first.contains("TRAE SOLO CN"), "第一个路径应包含 TRAE SOLO CN");
        
        // 最后一个路径应该是 ~/.trae/mcp.json
        let last = paths.last().unwrap().to_string_lossy();
        assert!(last.contains(".trae/mcp.json"), "最后一个路径应为 ~/.trae/mcp.json");
    }

    #[test]
    fn test_trae_detect_variant() {
        // 检测 TRAE SOLO CN 的 Application Support 目录
        let home = home_dir().expect("需要 HOME");
        let cn_dir = home.join("Library/Application Support/TRAE SOLO CN");
        let cn_dir2 = home.join("Library/Application Support/Trae CN");
        
        // 至少有一个 CN 目录应该存在
        assert!(cn_dir.is_dir() || cn_dir2.is_dir(), "应检测到 Trae CN 安装");
    }
}
