use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

const MIN_SQLITE_NODE_MODULES: u32 = 127;

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
        "/Applications/Visual Studio Code.app/Contents/Resources/app/resources/helpers/node"
            .into(),
        "/Applications/Trae CN.app/Contents/Resources/app/resources/helpers/node".into(),
        "/Applications/Trae.app/Contents/Resources/app/resources/helpers/node".into(),
    ];

    if let Ok(entries) = fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let volume = entry.path();
            for app in ["Cursor.app", "Trae CN.app", "Trae.app"] {
                let node = volume.join(app).join("Contents/Resources/app/resources/helpers/node");
                if node.is_file() {
                    paths.push(node.display().to_string());
                }
                if let Ok(children) = fs::read_dir(&volume) {
                    for child in children.flatten() {
                        let nested = child.path().join(app).join("Contents/Resources/app/resources/helpers/node");
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
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .ok()
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

/// 后台启动子进程，避免 macOS 从 GUI 应用拉起时弹出 Terminal 窗口。
pub fn configure_hidden_command(command: &mut Command) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

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
}
