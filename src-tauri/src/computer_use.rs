use std::path::{Path, PathBuf};
use std::process::Command;

const TRAE_BUNDLE_NAMES: [&str; 4] = [
    "Trae CN.app",
    "TRAE SOLO CN.app",
    "Trae.app",
    "TRAE SOLO.app",
];

const TRAE_PROCESS_NAMES: [&str; 5] = [
    "TRAE CN",
    "Trae CN",
    "TRAE SOLO CN",
    "TRAE SOLO",
    "Trae",
];

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
fn cu_open_delay_ms() -> u64 {
    std::env::var("DEVFLEET_CU_OPEN_DELAY_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4500)
}

#[cfg(target_os = "macos")]
fn start_trae_task_macos(workspace: &Path, prompt: &str) -> Result<(), String> {
    let app = find_trae_app_bundle().ok_or_else(|| "未找到 Trae / Trae CN 应用".to_string())?;
    let application_name = trae_application_name_from_bundle(&app);
    open_workspace_in_trae(&app, workspace)?;
    // Trae 打开工作区后 UI 就绪较慢；过早 osascript 会「只 open 不 send」。
    std::thread::sleep(std::time::Duration::from_millis(cu_open_delay_ms()));
    let script = build_trae_new_task_script(prompt, &application_name);
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
fn trae_application_name_from_bundle(app: &Path) -> String {
    app.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.trim_end_matches(".app").to_string())
        .unwrap_or_else(|| "Trae CN".to_string())
}

#[cfg(target_os = "macos")]
fn build_trae_new_task_script(prompt: &str, application_name: &str) -> String {
    let prompt = applescript_string(prompt);
    let process_list = TRAE_PROCESS_NAMES
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"set devfleetPrompt to {prompt}
set oldClipboard to ""
try
    set oldClipboard to the clipboard
end try
set the clipboard to devfleetPrompt

tell application "{application_name}" to activate

tell application "System Events"
    set traeProcessName to ""
    repeat 40 times
        repeat with candidateName in {{{process_list}}}
            if exists process (candidateName as text) then
                set traeProcessName to candidateName as text
                exit repeat
            end if
        end repeat
        if traeProcessName is not "" then exit repeat
        delay 0.5
    end repeat
    if traeProcessName is "" then error "Trae process not found after wait"

    tell process traeProcessName
        set frontmost to true

        repeat 30 times
            if (count of windows) > 0 then exit repeat
            delay 0.5
        end repeat
        if (count of windows) is 0 then error "Trae window not ready"

        delay 1.5
        set triggeredNewTask to false

        repeat with w in windows
            repeat with e in entire contents of w
                try
                    set elementName to name of e
                    set elementRole to role of e
                    if elementRole is "AXButton" or elementRole is "button" then
                        if elementName contains "新任务" or elementName contains "New Task" or elementName contains "新建任务" or elementName contains "Create Task" then
                            click e
                            set triggeredNewTask to true
                            exit repeat
                        end if
                    end if
                end try
            end repeat
            if triggeredNewTask then exit repeat
        end repeat

        if triggeredNewTask is false then
            try
                keystroke "n" using {{command down, shift down}}
                delay 1.2
                set triggeredNewTask to true
            end try
        end if

        if triggeredNewTask is false then
            try
                keystroke "n" using command down
                delay 1.0
                set triggeredNewTask to true
            end try
        end if

        if triggeredNewTask is false then
            try
                key code 45 using {{control down, command down}}
                delay 1.0
                set triggeredNewTask to true
            end try
        end if

        if triggeredNewTask is false then error "Failed to trigger Trae New Task (shortcut and button search failed)"

        delay 1.2

        -- 尽量聚焦输入框再粘贴，避免 Cmd+V 落到错误窗口
        set focusedInput to false
        repeat with w in windows
            repeat with e in entire contents of w
                try
                    set elementRole to role of e
                    if elementRole is "AXTextArea" or elementRole is "AXTextField" or elementRole is "text area" or elementRole is "text field" then
                        set focused of e to true
                        set focusedInput to true
                        exit repeat
                    end if
                end try
            end repeat
            if focusedInput then exit repeat
        end repeat

        keystroke "v" using command down
        delay 0.5
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
pub(crate) fn find_trae_app_bundle() -> Option<PathBuf> {
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
        let volume_root = entry.path();
        for name in TRAE_BUNDLE_NAMES {
            let direct = volume_root.join(name);
            if direct.is_dir() {
                return Some(direct);
            }
            let children = std::fs::read_dir(&volume_root).ok()?;
            for child in children.flatten() {
                let nested = child.path().join(name);
                if nested.is_dir() {
                    return Some(nested);
                }
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
    fn script_prefers_trae_cn_process_and_activate() {
        let script = build_trae_new_task_script("hello\nworld", "Trae CN");
        assert!(script.contains("\"TRAE CN\""));
        assert!(script.contains("tell application \"Trae CN\" to activate"));
        assert!(script.contains("triggeredNewTask"));
        assert!(script.contains("entire contents"));
        assert!(script.contains("command down, shift down"));
        assert!(script.contains("新任务"));
        assert!(script.contains("keystroke \"v\" using command down"));
        assert!(script.contains("\"hello\" & linefeed & \"world\""));
    }

    #[test]
    fn application_name_from_bundle_strips_app_suffix() {
        assert_eq!(
            trae_application_name_from_bundle(Path::new("/Volumes/Trae CN 1/Trae CN.app")),
            "Trae CN"
        );
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
