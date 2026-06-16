use std::path::Path;
use std::process::{Command, Stdio};

/// 解析本机 Node 可执行文件，避免 GUI 进程 PATH 不完整时误启动 shell 包装脚本。
pub fn resolve_node_executable() -> Option<String> {
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
        candidates.extend([
            "/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node".into(),
            "/Applications/Visual Studio Code.app/Contents/Resources/app/resources/helpers/node"
                .into(),
        ]);
    }

    for path in candidates {
        if Path::new(&path).is_file() {
            return Some(path);
        }
    }

    which_executable("node")
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
