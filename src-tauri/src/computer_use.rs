use std::path::{Path, PathBuf};
use std::process::Command;

pub fn start_trae_task(workspace: &Path, prompt: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        start_trae_task_macos(workspace, prompt)
    }

    #[cfg(target_os = "windows")]
    {
        start_trae_task_windows(workspace, prompt)
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = workspace;
        let _ = prompt;
        Err("当前内置 Computer Use 仅支持 macOS 与 Windows Trae".into())
    }
}

#[cfg(target_os = "macos")]
fn start_trae_task_macos(workspace: &Path, prompt: &str) -> Result<(), String> {
    let app = find_trae_app_bundle().ok_or_else(|| "未找到 Trae / Trae CN 应用".to_string())?;
    open_workspace_in_trae(&app, workspace)?;
    let script = build_trae_new_task_script(prompt);
    run_osascript(&script).map_err(|error| {
        format!(
            "Trae UI 自动控制失败: {error}。请在 macOS 系统设置中允许 DevFleet/Trae 使用“辅助功能”，或手动打开工作区后点“新任务”。"
        )
    })
}

#[cfg(target_os = "windows")]
fn start_trae_task_windows(workspace: &Path, prompt: &str) -> Result<(), String> {
    let script = resolve_trae_script_path()
        .ok_or_else(|| "未找到 trae-new-task.ps1 控制脚本".to_string())?;

    let prompt_file = write_prompt_temp_file(prompt)?;
    let result = run_powershell_script(&script, workspace, &prompt_file);
    let _ = std::fs::remove_file(&prompt_file);
    result.map_err(|error| {
        format!(
            "Trae UI 自动控制失败: {error}。请确认 Trae 已安装、Windows 处于交互式登录会话，且 DevFleet 与 Trae 同级权限运行；也可手动打开工作区后点“新任务”。"
        )
    })
}

#[cfg(target_os = "macos")]
fn open_workspace_in_trae(app: &Path, workspace: &Path) -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .arg("-a")
        .arg(app)
        .arg(workspace)
        .status()
        .map_err(|error| format!("无法调用 open 打开 Trae: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "open 打开 Trae 失败，退出码 {}",
            status.code().unwrap_or(-1)
        ))
    }
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("无法启动 osascript: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    Err(if detail.is_empty() {
        format!("osascript 退出码 {}", output.status.code().unwrap_or(-1))
    } else {
        detail
    })
}

#[cfg(target_os = "windows")]
fn run_powershell_script(
    script: &Path,
    workspace: &Path,
    prompt_file: &Path,
) -> Result<(), String> {
    let output = Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script)
        .arg("-WorkspacePath")
        .arg(workspace)
        .arg("-PromptPath")
        .arg(prompt_file)
        .output()
        .map_err(|error| format!("无法启动 PowerShell: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    Err(if detail.is_empty() {
        format!(
            "PowerShell 退出码 {}",
            output.status.code().unwrap_or(-1)
        )
    } else {
        detail
    })
}

#[cfg(target_os = "windows")]
fn write_prompt_temp_file(prompt: &str) -> Result<PathBuf, String> {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "devfleet-trae-prompt-{}.txt",
        std::process::id()
    ));
    std::fs::write(&path, prompt).map_err(|error| format!("无法写入临时 prompt 文件: {error}"))?;
    Ok(path)
}

#[cfg(target_os = "windows")]
pub(crate) fn resolve_trae_script_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("DEVFLEET_COMPUTER_USE_SCRIPT") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in resource_script_candidates(dir) {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    let dev_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../scripts/computer-use/trae-new-task.ps1");
    if dev_script.is_file() {
        return Some(dev_script);
    }

    None
}

#[cfg(target_os = "windows")]
fn resource_script_candidates(exe_dir: &Path) -> [PathBuf; 4] {
    [
        exe_dir.join("resources/scripts/trae-new-task.ps1"),
        exe_dir.join("scripts/trae-new-task.ps1"),
        exe_dir.join("../resources/scripts/trae-new-task.ps1"),
        exe_dir.join("../../resources/scripts/trae-new-task.ps1"),
    ]
}

#[cfg(target_os = "macos")]
fn build_trae_new_task_script(prompt: &str) -> String {
    let prompt = applescript_string(prompt);
    format!(
        r#"set devfleetPrompt to {prompt}
set oldClipboard to ""
try
    set oldClipboard to the clipboard
end try

tell application "System Events"
    set traeProcessName to ""
    repeat with candidateName in {{"TRAE CN", "Trae CN", "TRAE SOLO CN", "TRAE SOLO", "Trae"}}
        if exists process (candidateName as text) then
            set traeProcessName to candidateName as text
            exit repeat
        end if
    end repeat
    if traeProcessName is "" then error "Trae process not found"

    tell process traeProcessName
        set frontmost to true
        delay 1.2
        key code 45 using {{control down, command down}}
        delay 0.8
        set the clipboard to devfleetPrompt
        keystroke "v" using command down
        delay 0.4
        key code 36
    end tell
end tell

delay 0.2
try
    set the clipboard to oldClipboard
end try"#
    )
}

#[cfg(target_os = "macos")]
fn applescript_string(value: &str) -> String {
    let mut parts = Vec::new();
    let mut current = String::new();
    for ch in value.chars() {
        match ch {
            '"' => current.push_str("\\\""),
            '\\' => current.push_str("\\\\"),
            '\n' => {
                if !current.is_empty() {
                    parts.push(format!("\"{current}\""));
                    current.clear();
                }
                parts.push("linefeed".to_string());
            }
            '\r' => {}
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        parts.push(format!("\"{current}\""));
    }
    if parts.is_empty() {
        "\"\"".to_string()
    } else {
        parts.join(" & ")
    }
}

#[cfg(target_os = "macos")]
fn find_trae_app_bundle() -> Option<PathBuf> {
    let candidates = [
        "/Applications/Trae CN.app",
        "/Applications/TRAE SOLO CN.app",
        "/Applications/Trae.app",
        "/Applications/TRAE SOLO.app",
        "/Volumes/Trae CN/Trae CN.app",
        "/Volumes/TRAE Work CN/TRAE SOLO CN.app",
        "/Volumes/TRAE Work/TRAE SOLO.app",
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_dir())
        .or_else(find_trae_app_under_volumes)
}

#[cfg(target_os = "macos")]
fn find_trae_app_under_volumes() -> Option<PathBuf> {
    let entries = std::fs::read_dir("/Volumes").ok()?;
    for entry in entries.flatten() {
        for name in [
            "Trae CN.app",
            "TRAE SOLO CN.app",
            "Trae.app",
            "TRAE SOLO.app",
        ] {
            let path = entry.path().join(name);
            if path.is_dir() {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    #[test]
    fn script_uses_new_task_shortcut_and_pastes_prompt() {
        let script = build_trae_new_task_script("hello\nworld");
        assert!(script.contains("key code 45 using {control down, command down}"));
        assert!(script.contains("keystroke \"v\" using command down"));
        assert!(script.contains("\"hello\" & linefeed & \"world\""));
    }
}

#[cfg(test)]
#[cfg(target_os = "windows")]
mod tests {
    use super::*;

    #[test]
    fn dev_script_path_points_to_repo_script() {
        let path = resolve_trae_script_path().expect("dev script path");
        assert!(path.ends_with("trae-new-task.ps1"));
    }

    #[test]
    fn prompt_temp_file_roundtrip() {
        let path = write_prompt_temp_file("hello\r\nworld").expect("write temp");
        let content = std::fs::read_to_string(&path).expect("read temp");
        let _ = std::fs::remove_file(path);
        assert_eq!(content, "hello\r\nworld");
    }

    #[test]
    fn powershell_command_uses_prompt_file_args() {
        let script = PathBuf::from(r"C:\DevFleet\trae-new-task.ps1");
        let workspace = PathBuf::from(r"C:\work\repo");
        let prompt_file = PathBuf::from(r"C:\Temp\prompt.txt");
        let rendered = format!(
            "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {} -WorkspacePath {} -PromptPath {}",
            script.display(),
            workspace.display(),
            prompt_file.display()
        );
        assert!(rendered.contains("-PromptPath"));
        assert!(rendered.contains("prompt.txt"));
    }
}
