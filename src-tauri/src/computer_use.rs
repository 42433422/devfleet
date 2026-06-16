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

const TRAE_WORKSPACE_SETTINGS: &str = "{\n  \"security.workspace.trust.enabled\": false\n}\n";

pub fn prepare_trae_workspace_settings(workspace: &Path) -> Result<(), String> {
    let vscode_dir = workspace.join(".vscode");
    std::fs::create_dir_all(&vscode_dir)
        .map_err(|error| format!("创建 .vscode 目录失败: {error}"))?;
    std::fs::write(vscode_dir.join("settings.json"), TRAE_WORKSPACE_SETTINGS)
        .map_err(|error| format!("写入工作区信任设置失败: {error}"))?;
    Ok(())
}

pub fn open_trae_workspace(workspace: &Path) -> Result<(), String> {
    prepare_trae_workspace_settings(workspace)?;
    #[cfg(target_os = "macos")]
    {
        let app = find_trae_app_bundle().ok_or_else(|| "未找到 Trae / Trae CN 应用".to_string())?;
        let application_name = trae_application_name_from_bundle(&app);
        open_workspace_in_trae(&app, workspace, &application_name)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = workspace;
        Err("open_trae_workspace 目前仅在 macOS 上拆分支持；Windows 请使用 start_trae_task".into())
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = workspace;
        Err("当前平台不支持 Trae Computer Use".into())
    }
}

pub fn submit_trae_new_task(workspace: &Path, prompt: &str) -> Result<(), String> {
    prepare_trae_workspace_settings(workspace)?;
    #[cfg(target_os = "macos")]
    {
        submit_trae_new_task_macos(workspace, prompt, false)
    }
    #[cfg(target_os = "windows")]
    {
        start_trae_task_windows(workspace, prompt)
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = (workspace, prompt);
        Err("当前内置 Computer Use 仅支持 macOS 与 Windows Trae".into())
    }
}

pub fn start_trae_task(workspace: &Path, prompt: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        start_trae_task_macos(workspace, prompt)
    }
    #[cfg(target_os = "windows")]
    {
        prepare_trae_workspace_settings(workspace)?;
        start_trae_task_windows(workspace, prompt)
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = (workspace, prompt);
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
fn cu_wait_timeout_ms() -> u64 {
    std::env::var("DEVFLEET_CU_WAIT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(90_000)
}

#[cfg(target_os = "macos")]
fn cu_wait_poll_ms() -> u64 {
    std::env::var("DEVFLEET_CU_WAIT_POLL_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(500)
}

#[cfg(target_os = "macos")]
fn start_trae_task_macos(workspace: &Path, prompt: &str) -> Result<(), String> {
    run_trae_computer_use(workspace, prompt, TraeCuMode::OpenAndSubmit)
}

#[cfg(target_os = "macos")]
enum TraeCuMode {
    OpenAndSubmit,
    SubmitOnly,
}

#[cfg(target_os = "macos")]
fn run_trae_computer_use(workspace: &Path, prompt: &str, mode: TraeCuMode) -> Result<(), String> {
    prepare_trae_workspace_settings(workspace)?;
    let app = find_trae_app_bundle().ok_or_else(|| "未找到 Trae / Trae CN 应用".to_string())?;
    let application_name = trae_application_name_from_bundle(&app);
    let trae_cli = resolve_trae_cli(&app);
    let baseline = trae_open_baseline();
    let already_open = trae_workspace_window_is_open(workspace, &application_name);
    let open_workspace = matches!(mode, TraeCuMode::OpenAndSubmit) && !already_open;
    let reuse_existing = !open_workspace;
    if reuse_existing {
        focus_trae_workspace_window(workspace, &application_name)?;
    }
    let script = build_trae_atomic_submit_script(
        prompt,
        &application_name,
        workspace,
        &baseline,
        open_workspace,
        reuse_existing,
        trae_cli.as_deref(),
        &app,
    );
    run_osascript(&script).map_err(|error| {
        format!(
            "Trae 自动控制失败: {error}。请确认 macOS 辅助功能已授权 DevFleet 与 Trae。"
        )
    })
}

#[cfg(target_os = "macos")]
fn submit_trae_new_task_macos(workspace: &Path, prompt: &str, _skip_wait: bool) -> Result<(), String> {
    run_trae_computer_use(workspace, prompt, TraeCuMode::SubmitOnly)
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
fn resolve_trae_cli(app: &Path) -> Option<PathBuf> {
    let bin_dir = app.join("Contents/Resources/app/bin");
    for name in ["trae-cn", "trae", "code", "marscode"] {
        let candidate = bin_dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn open_workspace_in_trae(
    app: &Path,
    workspace: &Path,
    application_name: &str,
) -> Result<(), String> {
    let _ = app;
    let workspace_path = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let script = format!(
        r#"tell application "{app_name}"
    activate
    open POSIX file "{path}"
end tell"#,
        app_name = applescript_escape(application_name),
        path = applescript_escape(workspace_path.to_string_lossy().as_ref()),
    );
    run_osascript(&script).map_err(|error| format!("无法打开 Trae 工作区: {error}"))
}

#[cfg(target_os = "macos")]
fn trae_workspace_window_is_open(workspace: &Path, application_name: &str) -> bool {
    let probe = build_trae_window_probe_script(application_name, workspace, None);
    matches!(
        run_osascript_capture(&probe).ok().as_deref(),
        Some("ready")
    )
}

#[cfg(target_os = "macos")]
fn focus_trae_workspace_window(workspace: &Path, application_name: &str) -> Result<(), String> {
    let script = build_trae_focus_script(application_name, workspace);
    run_osascript(&script).map_err(|error| format!("聚焦 Trae 工作区窗口失败: {error}"))
}

#[cfg(target_os = "macos")]
fn build_trae_focus_script(application_name: &str, workspace: &Path) -> String {
    let process_list = TRAE_PROCESS_NAMES
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let folder_name = applescript_escape(&workspace_folder_name(workspace));
    let app_name = applescript_escape(application_name);
    let match_block = trae_window_match_block(&folder_name, &app_name);
    format!(
        r#"tell application "System Events"
    set traeProcessName to ""
    repeat with candidateName in {{{process_list}}}
        if exists process (candidateName as text) then
            set traeProcessName to candidateName as text
            exit repeat
        end if
    end repeat
    if traeProcessName is "" then error "Trae process not found"
    tell process traeProcessName
        set frontmost to true
        {match_block}
        if targetWindow is missing value then error "Trae workspace window not found"
        click targetWindow
        delay 0.5
        click targetWindow
    end tell
end tell"#
    )
}

#[cfg(target_os = "macos")]
fn run_osascript_capture(script: &str) -> Result<String, String> {
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("无法启动 osascript: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    Err(format_osascript_error(&detail, output.status.code().unwrap_or(-1)))
}

#[cfg(target_os = "macos")]
fn wait_for_trae_workspace_window(
    workspace: &Path,
    application_name: &str,
    baseline: Option<&TraeOpenBaseline>,
) -> Result<(), String> {
    let probe = build_trae_window_probe_script(application_name, workspace, baseline);
    let timeout = std::time::Duration::from_millis(cu_wait_timeout_ms());
    let poll = std::time::Duration::from_millis(cu_wait_poll_ms());
    let started = std::time::Instant::now();
    loop {
        if let Ok(state) = run_osascript_capture(&probe) {
            if state == "ready" {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                return Ok(());
            }
        }
        if started.elapsed() >= timeout {
            break;
        }
        std::thread::sleep(poll);
    }
    Err(format!(
        "等待 Trae 工作区窗口「{}」就绪超时（{}ms）",
        workspace_folder_name(workspace),
        cu_wait_timeout_ms()
    ))
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
    Err(format_osascript_error(&detail, output.status.code().unwrap_or(-1)))
}

#[cfg(target_os = "macos")]
fn format_osascript_error(detail: &str, exit_code: i32) -> String {
    let base = if detail.is_empty() {
        format!("osascript 退出码 {exit_code}")
    } else {
        detail.to_string()
    };
    if base.contains("-25211")
        || base.contains("辅助访问")
        || base.to_ascii_lowercase().contains("assistive")
        || base.to_ascii_lowercase().contains("not allowed assistive")
    {
        return format!(
            "{base}。请在「系统设置 → 隐私与安全性 → 辅助功能」中勾选 DevFleet（及 Trae），然后完全退出并重新打开 DevFleet App。"
        );
    }
    base
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
fn workspace_window_needles(workspace: &Path) -> Vec<String> {
    let mut needles = Vec::new();
    if let Some(name) = workspace.file_name().and_then(|value| value.to_str()) {
        if !name.is_empty() && name != "." {
            needles.push(name.to_string());
        }
    }
    if let Some(parent) = workspace
        .parent()
        .and_then(|path| path.file_name())
        .and_then(|value| value.to_str())
    {
        if !parent.is_empty() && !matches!(parent, "." | "tmp" | "private" | "var" | "Volumes") {
            needles.push(parent.to_string());
        }
    }
    if let Ok(canonical) = workspace.canonicalize() {
        if let Some(path) = canonical.to_str() {
            for segment in ["/agent-workspace/", "/devfleet-e2e/"] {
                if let Some(tail) = path.split(segment).nth(1) {
                    let token = tail.split('/').next().unwrap_or("");
                    if !token.is_empty() {
                        needles.push(token.to_string());
                    }
                }
            }
        }
    }
    needles.sort();
    needles.dedup();
    needles
}

#[cfg(target_os = "macos")]
fn workspace_folder_name(workspace: &Path) -> String {
    workspace
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|name| !name.is_empty() && *name != ".")
        .unwrap_or("devfleet")
        .to_string()
}

#[cfg(target_os = "macos")]
fn applescript_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn trae_window_count() -> u32 {
    let process_list = TRAE_PROCESS_NAMES
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!(
        r#"tell application "System Events"
    repeat with candidateName in {{{process_list}}}
        if exists process (candidateName as text) then
            return count of windows of process (candidateName as text)
        end if
    end repeat
    return 0
end tell"#
    );
    match run_osascript_capture(&script) {
        Ok(raw) => raw.parse().unwrap_or(0),
        Err(_) => 0,
    }
}

#[cfg(target_os = "macos")]
struct TraeOpenBaseline {
    titles: Vec<String>,
    window_count: u32,
}

#[cfg(target_os = "macos")]
fn trae_open_baseline() -> TraeOpenBaseline {
    TraeOpenBaseline {
        titles: trae_window_titles(),
        window_count: trae_window_count(),
    }
}

#[cfg(target_os = "macos")]
fn trae_window_titles() -> Vec<String> {
    let process_list = TRAE_PROCESS_NAMES
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!(
        r#"tell application "System Events"
    set traeProcessName to ""
    repeat with candidateName in {{{process_list}}}
        if exists process (candidateName as text) then
            set traeProcessName to candidateName as text
            exit repeat
        end if
    end repeat
    if traeProcessName is "" then return ""
    set titleList to {{}}
    tell process traeProcessName
        repeat with w in windows
            try
                set end of titleList to name of w as text
            end try
        end repeat
    end tell
    set AppleScript's text item delimiters to linefeed
    return titleList as text
end tell"#
    );
    match run_osascript_capture(&script) {
        Ok(raw) if raw.is_empty() => Vec::new(),
        Ok(raw) => raw.lines().map(str::to_string).collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(target_os = "macos")]
fn trae_window_match_block(folder_name: &str, app_name: &str) -> String {
    format!(
        r#"set workspaceFolderName to "{folder_name}"
        set traeAppTitle to "{app_name}"
        set targetWindow to missing value
        repeat with i from (count of windows) to 1 by -1
            set w to window i
            try
                set windowTitle to name of w as text
                if windowTitle is workspaceFolderName then
                    set targetWindow to w
                    exit repeat
                end if
            end try
        end repeat
        if targetWindow is missing value then
            repeat with i from (count of windows) to 1 by -1
                set w to window i
                try
                    set windowTitle to name of w as text
                    if windowTitle contains workspaceFolderName then
                        if windowTitle is not traeAppTitle and windowTitle is not "Trae CN" and windowTitle is not "TRAE CN" and windowTitle is not "Trae" and windowTitle is not "TRAE SOLO CN" and windowTitle is not "TRAE SOLO" then
                            set targetWindow to w
                            exit repeat
                        end if
                    end if
                end try
            end repeat
        end if"#
    )
}

#[cfg(target_os = "macos")]
fn build_trae_window_probe_script(
    application_name: &str,
    workspace: &Path,
    baseline: Option<&TraeOpenBaseline>,
) -> String {
    let process_list = TRAE_PROCESS_NAMES
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let folder_name = applescript_escape(&workspace_folder_name(workspace));
    let app_name = applescript_escape(application_name);
    let baseline_list = baseline
        .map(|value| {
            if value.titles.is_empty() {
                "\"\"".to_string()
            } else {
                value
                    .titles
                    .iter()
                    .map(|title| format!("\"{}\"", applescript_escape(title)))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        })
        .unwrap_or_else(|| "\"\"".to_string());
    let baseline_count = baseline.map(|value| value.window_count).unwrap_or(0);
    let use_baseline = baseline.is_some();
    let match_block = trae_window_match_block(&folder_name, &app_name);
    let baseline_gate = if use_baseline {
        format!(
            r#"if (count of windows) > {baseline_count} then return "ready"
        set baselineTitles to {{{baseline_list}}}
        repeat with oldTitle in baselineTitles
            if oldTitle is not "" and windowTitle is oldTitle then return "waiting"
        end repeat"#
        )
    } else {
        String::new()
    };
    format!(
        r#"tell application "System Events"
    set traeProcessName to ""
    repeat with candidateName in {{{process_list}}}
        if exists process (candidateName as text) then
            set traeProcessName to candidateName as text
            exit repeat
        end if
    end repeat
    if traeProcessName is "" then return "waiting"
    tell process traeProcessName
        if (count of windows) is 0 then return "waiting"
        {match_block}
        if targetWindow is missing value then return "waiting"
        set windowTitle to name of targetWindow as text
        {baseline_gate}
        return "ready"
    end tell
end tell"#
    )
}

#[cfg(target_os = "macos")]
fn build_trae_workspace_path_vars(workspace: &Path) -> String {
    let workspace_path = applescript_escape(
        workspace
            .canonicalize()
            .unwrap_or_else(|_| workspace.to_path_buf())
            .to_string_lossy()
            .as_ref(),
    );
    format!(r#"set workspacePath to "{workspace_path}""#)
}

#[cfg(target_os = "macos")]
fn build_trae_open_at_start_block(
    workspace: &Path,
    application_name: &str,
    open_workspace: bool,
) -> String {
    if !open_workspace {
        return String::new();
    }
    let workspace_path_vars = build_trae_workspace_path_vars(workspace);
    let app_name = applescript_escape(application_name);
    format!(
        r#"{workspace_path_vars}
set traeAppName to "{app_name}"
tell application traeAppName
    activate
    open POSIX file workspacePath
end tell
delay 3.0
"#
    )
}

#[cfg(target_os = "macos")]
fn build_trae_atomic_submit_script(
    prompt: &str,
    application_name: &str,
    workspace: &Path,
    baseline: &TraeOpenBaseline,
    open_workspace: bool,
    reuse_existing: bool,
    _trae_cli: Option<&Path>,
    _app: &Path,
) -> String {
    let prompt = applescript_string(prompt);
    let process_list = TRAE_PROCESS_NAMES
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let folder_name = applescript_escape(&workspace_folder_name(workspace));
    let app_name = applescript_escape(application_name);
    let needles_error = workspace_window_needles(workspace).join(", ");
    let match_block = trae_window_match_block(&folder_name, &app_name);
    let baseline_list = if baseline.titles.is_empty() {
        "\"\"".to_string()
    } else {
        baseline
            .titles
            .iter()
            .map(|title| format!("\"{}\"", applescript_escape(title)))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let baseline_count = baseline.window_count;
    let workspace_path_vars = build_trae_workspace_path_vars(workspace);
    let open_at_start = build_trae_open_at_start_block(workspace, application_name, open_workspace);
    let need_open = if open_workspace { "true" } else { "false" };
    let reuse_existing_as = if reuse_existing { "true" } else { "false" };
    format!(
        r#"{open_at_start}set devfleetPrompt to {prompt}
set oldClipboard to ""
try
    set oldClipboard to the clipboard
end try
set the clipboard to devfleetPrompt

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
        {workspace_path_vars}
        set needOpenWorkspace to {need_open}
        set reuseExistingWindow to {reuse_existing_as}
        set baselineWindowCount to {baseline_count}
        set baselineTitles to {{{baseline_list}}}
        set targetWindow to missing value

        -- 先匹配窗口，找到后再 frontmost，避免提前激活欢迎页
        repeat with matchAttempt from 1 to 180
            set targetWindow to missing value
            if (count of windows) is 0 then
                delay 0.5
            else
                {match_block}
                if targetWindow is not missing value then
                    set windowTitle to name of targetWindow as text
                    if windowTitle is "Trae CN" or windowTitle is "TRAE CN" or windowTitle is "Trae" then
                        set targetWindow to missing value
                    else if windowTitle is workspaceFolderName or windowTitle contains workspaceFolderName then
                        if reuseExistingWindow then
                            exit repeat
                        else if (count of windows) > baselineWindowCount then
                            exit repeat
                        else
                            set seenBefore to false
                            repeat with oldTitle in baselineTitles
                                if oldTitle is not "" and windowTitle is oldTitle then
                                    set seenBefore to true
                                    exit repeat
                                end if
                            end repeat
                            if seenBefore is false then exit repeat
                            set targetWindow to missing value
                        end if
                    end if
                end if
            end if
            delay 0.5
        end repeat

        if targetWindow is missing value then error "Trae workspace window not found ({needles_error})"
        set frontmost to true
        click targetWindow
        delay 0.8
        click targetWindow
        delay 1.0

        set dismissedTrust to false
        repeat with trustAttempt from 1 to 8
            repeat with e in entire contents of targetWindow
                try
                    set elementName to name of e
                    set elementRole to role of e
                    if elementRole is "AXButton" or elementRole is "button" then
                        if elementName contains "我信任" or elementName contains "I trust" or elementName contains "trust the author" then
                            click e
                            set dismissedTrust to true
                            delay 1.5
                            exit repeat
                        end if
                    end if
                    if elementRole is "AXCheckBox" or elementRole is "checkbox" then
                        if elementName contains "agent-workspace" or elementName contains "父文件夹" or elementName contains "parent folder" then
                            click e
                        end if
                    end if
                end try
            end repeat
            if dismissedTrust then exit repeat
            delay 0.8
        end repeat

        set triggeredNewTask to false
        repeat with e in entire contents of targetWindow
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

        if triggeredNewTask is false then
            try
                click targetWindow
                delay 0.3
                keystroke "n" using {{control down, command down}}
                delay 1.2
                set triggeredNewTask to true
            end try
        end if

        if triggeredNewTask is false then error "Failed to trigger Trae New Task"

        delay 1.2
        repeat with e in entire contents of targetWindow
            try
                set elementRole to role of e
                if elementRole is "AXTextArea" or elementRole is "AXTextField" or elementRole is "text area" or elementRole is "text field" then
                    set focused of e to true
                    exit repeat
                end if
            end try
        end repeat

        keystroke "v" using command down
        delay 0.5
        key code 36
    end tell
end tell

delay 0.2
try
    set the clipboard to oldClipboard
end try"#,
        baseline_count = baseline_count,
        needles_error = needles_error,
        match_block = match_block,
        workspace_path_vars = workspace_path_vars,
        need_open = need_open,
        reuse_existing_as = reuse_existing_as,
        open_at_start = open_at_start,
    )
}

#[cfg(target_os = "macos")]
fn build_trae_submit_script(
    prompt: &str,
    application_name: &str,
    workspace: &Path,
    app: &Path,
    trae_cli: Option<&Path>,
) -> String {
    build_trae_atomic_submit_script(
        prompt,
        application_name,
        workspace,
        &TraeOpenBaseline {
            titles: Vec::new(),
            window_count: 0,
        },
        false,
        true,
        trae_cli,
        app,
    )
}

#[cfg(target_os = "macos")]
fn build_trae_new_task_script(
    prompt: &str,
    application_name: &str,
    workspace: &Path,
    open_workspace: bool,
    trae_cli: Option<&Path>,
    app: &Path,
) -> String {
    build_trae_atomic_submit_script(
        prompt,
        application_name,
        workspace,
        &TraeOpenBaseline {
            titles: Vec::new(),
            window_count: 0,
        },
        open_workspace,
        !open_workspace,
        trae_cli,
        app,
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
        let workspace = Path::new("/tmp/devfleet-e2e/agent-workspace/task-abc");
        let app = Path::new("/Applications/Trae CN.app");
        let cli = app.join("Contents/Resources/app/bin/trae-cn");
        let script = build_trae_new_task_script(
            "hello\nworld",
            "Trae CN",
            workspace,
            true,
            Some(&cli),
            app,
        );
        assert!(script.contains("\"TRAE CN\""));
        assert!(script.contains("open POSIX file workspacePath"));
        assert!(!script.contains("do shell script"));
        assert!(!script.contains("user-data-dir"));
        assert!(!script.contains("-n"));
        assert!(script.contains("reuseExistingWindow"));
        assert!(script.contains("task-abc"));
        assert!(script.contains("我信任"));
        assert!(script.contains("triggeredNewTask"));
        assert!(script.contains("entire contents of targetWindow"));
        assert!(script.contains("control down, command down"));
        assert!(script.contains("新任务"));
        assert!(script.contains("keystroke \"v\" using command down"));
        assert!(script.contains("\"hello\" & linefeed & \"world\""));
    }

    #[test]
    fn workspace_window_needles_include_folder_and_parent() {
        let needles = workspace_window_needles(Path::new("/tmp/devfleet-e2e/agent-workspace/uuid-task"));
        assert!(needles.contains(&"uuid-task".to_string()));
        assert!(needles.contains(&"agent-workspace".to_string()));
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
