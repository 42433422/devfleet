use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, State};
use tokio::{
    process::Command,
    sync::mpsc,
    time::{self, Duration},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub api_base_url: String,
    pub device_token: String,
    pub device_id: String,
    pub device_name: String,
    pub controller_id: String,
    pub controller_email: String,
    pub controller_device_id: Option<String>,
    pub controller_device_name: Option<String>,
    pub workspace_root: String,
    pub dev_tool: String,
    pub default_editor: String,
    pub executor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolStatus {
    pub tool_name: String,
    pub status: String,
    pub installed: bool,
    pub executable: Option<String>,
    pub current_task: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub configured: bool,
    pub connected: bool,
    pub config: Option<AgentConfig>,
    pub tools: Vec<LocalToolStatus>,
    pub running_task: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ExecuteTask {
    task_id: String,
    subtask_id: String,
    title: String,
    description: String,
    repo_url: String,
    base_branch: String,
    work_branch: String,
    tool: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivationResponse {
    device: ActivatedDevice,
    device_token: String,
    controller: ControllerIdentity,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivatedDevice {
    id: String,
    name: String,
    #[serde(default)]
    dev_tool: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ControllerIdentity {
    id: String,
    email: String,
    #[serde(rename = "primaryDevice")]
    primary_device: Option<ControllerDevice>,
}

#[derive(Debug, Clone, Deserialize)]
struct ControllerDevice {
    id: String,
    name: String,
}

struct AgentInner {
    config_path: PathBuf,
    config: Mutex<Option<AgentConfig>>,
    connected: Mutex<bool>,
    tools: Mutex<Vec<LocalToolStatus>>,
    running_task: Mutex<Option<String>>,
    running_dev_tool: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    generation: AtomicU64,
    loop_running: AtomicBool,
    paused: AtomicBool,
}

#[derive(Clone)]
pub struct AgentState {
    inner: Arc<AgentInner>,
}

impl AgentState {
    pub fn load(app: &AppHandle) -> Self {
        let config_dir = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let config_path = config_dir.join("agent.json");
        let config = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<AgentConfig>(&raw).ok());
        Self {
            inner: Arc::new(AgentInner {
                config_path,
                config: Mutex::new(config),
                connected: Mutex::new(false),
                tools: Mutex::new(scan_tools(None, None)),
                running_task: Mutex::new(None),
                running_dev_tool: Mutex::new(None),
                last_error: Mutex::new(None),
                generation: AtomicU64::new(0),
                loop_running: AtomicBool::new(false),
                paused: AtomicBool::new(false),
            }),
        }
    }

    fn save_config(&self, config: &AgentConfig) -> Result<(), String> {
        if let Some(parent) = self.inner.config_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let raw = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
        std::fs::write(&self.inner.config_path, raw).map_err(|error| error.to_string())
    }

    fn update_controller_identity(
        &self,
        identity: ControllerIdentity,
        dev_tool: Option<String>,
    ) -> Result<(), String> {
        let updated = {
            let mut config = self
                .inner
                .config
                .lock()
                .map_err(|_| "无法更新绑定身份".to_string())?;
            let Some(config) = config.as_mut() else {
                return Ok(());
            };
            config.controller_id = identity.id;
            config.controller_email = identity.email;
            config.controller_device_id = identity
                .primary_device
                .as_ref()
                .map(|device| device.id.clone());
            config.controller_device_name = identity.primary_device.map(|device| device.name);
            if let Some(tool) = dev_tool.filter(|value| !value.trim().is_empty()) {
                config.dev_tool = tool;
                config.default_editor = config.dev_tool.clone();
            }
            config.clone()
        };
        self.save_config(&updated)
    }

    fn start(&self) {
        if self
            .inner
            .config
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .is_none()
        {
            return;
        }
        self.inner.paused.store(false, Ordering::SeqCst);
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        if self
            .inner
            .loop_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let generation = state.inner.generation.load(Ordering::SeqCst);
            state.run_loop(generation).await;
            state.inner.loop_running.store(false, Ordering::SeqCst);
            let latest = state.inner.generation.load(Ordering::SeqCst);
            let should_restart = !state.inner.paused.load(Ordering::SeqCst)
                && state
                    .inner
                    .config
                    .lock()
                    .ok()
                    .and_then(|value| value.clone())
                    .is_some()
                && latest != generation;
            if should_restart {
                state.start();
            }
        });
    }

    fn stop(&self) {
        self.inner.paused.store(true, Ordering::SeqCst);
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        self.inner.loop_running.store(false, Ordering::SeqCst);
        set_mutex(&self.inner.connected, false);
        set_mutex(&self.inner.running_task, None);
    }

    async fn run_loop(&self, generation: u64) {
        let mut backoff_secs = 5u64;
        loop {
            if self.inner.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let config = self
                .inner
                .config
                .lock()
                .ok()
                .and_then(|value| value.clone());
            let Some(config) = config else {
                return;
            };
            let ws_url = format!(
                "{}/ws/device?token={}",
                config
                    .api_base_url
                    .trim_end_matches('/')
                    .replacen("http://", "ws://", 1)
                    .replacen("https://", "wss://", 1),
                config.device_token
            );
            match connect_async(&ws_url).await {
                Ok((socket, _)) => {
                    set_mutex(&self.inner.connected, true);
                    set_mutex(&self.inner.last_error, None);
                    backoff_secs = 5;
                    if let Err(error) = self
                        .run_connection(socket, config.clone(), generation)
                        .await
                    {
                        set_mutex(&self.inner.last_error, Some(error));
                    }
                }
                Err(error) => set_mutex(
                    &self.inner.last_error,
                    Some(format!("连接服务器失败: {error}")),
                ),
            }
            set_mutex(&self.inner.connected, false);
            if self.inner.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if !self.interruptible_sleep(generation, backoff_secs).await {
                return;
            }
            backoff_secs = (backoff_secs * 2).min(60);
        }
    }

    async fn interruptible_sleep(&self, generation: u64, seconds: u64) -> bool {
        for _ in 0..seconds * 10 {
            if self.inner.generation.load(Ordering::SeqCst) != generation {
                return false;
            }
            time::sleep(Duration::from_millis(100)).await;
        }
        true
    }

    async fn run_connection<S>(
        &self,
        socket: tokio_tungstenite::WebSocketStream<S>,
        config: AgentConfig,
        generation: u64,
    ) -> Result<(), String>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (mut writer, mut reader) = socket.split();
        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Value>();
        let mut heartbeat = time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        let mut tool_status = time::interval(Duration::from_secs(30));
        tool_status.set_missed_tick_behavior(time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
              _ = heartbeat.tick() => {
                if self.inner.generation.load(Ordering::SeqCst) != generation {
                  let _ = writer.close().await;
                  return Ok(());
                }
                writer.send(Message::Ping(Vec::new().into())).await.map_err(|error| error.to_string())?;
              }
              _ = tool_status.tick() => {
                if self.inner.generation.load(Ordering::SeqCst) != generation {
                  let _ = writer.close().await;
                  return Ok(());
                }
                let running_task = self.inner.running_task.lock().ok().and_then(|value| value.clone());
                let running_dev_tool = self
                    .inner
                    .running_dev_tool
                    .lock()
                    .ok()
                    .and_then(|value| value.clone());
                let tools = scan_tools(running_task.as_deref(), running_dev_tool.as_deref());
                set_mutex(&self.inner.tools, tools.clone());
                let payload = json!({
                  "type": "tool_status",
                  "tools": tools.into_iter().map(|tool| json!({
                    "tool_name": tool.tool_name,
                    "status": tool.status,
                    "current_task": tool.current_task,
                  })).collect::<Vec<_>>()
                });
                writer.send(Message::Text(payload.to_string().into())).await.map_err(|error| error.to_string())?;
              }
              Some(payload) = outbound_rx.recv() => {
                writer.send(Message::Text(payload.to_string().into())).await.map_err(|error| error.to_string())?;
              }
              message = reader.next() => {
                match message {
                  Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
                    if value.get("type").and_then(Value::as_str) == Some("binding_identity") {
                      let identity = value.get("controller").cloned().ok_or_else(|| "绑定身份消息缺少 controller".to_string())?;
                      let identity: ControllerIdentity = serde_json::from_value(identity).map_err(|error| error.to_string())?;
                      let dev_tool = value.get("devTool").and_then(Value::as_str).map(str::to_string);
                      self.update_controller_identity(identity, dev_tool)?;
                      continue;
                    }
                    if value.get("type").and_then(Value::as_str) == Some("execute_task") {
                      let task: ExecuteTask = serde_json::from_value(value).map_err(|error| error.to_string())?;
                      let state = self.clone();
                      let task_config = config.clone();
                      let task_tx = outbound_tx.clone();
                      tauri::async_runtime::spawn(async move {
                        state.execute_task(task_config, task, task_tx).await;
                      });
                    }
                  }
                  Some(Ok(Message::Ping(data))) => writer.send(Message::Pong(data)).await.map_err(|error| error.to_string())?,
                  Some(Ok(Message::Close(_))) | None => return Ok(()),
                  Some(Err(error)) => return Err(error.to_string()),
                  _ => {}
                }
              }
            }
        }
    }

    async fn execute_task(
        &self,
        config: AgentConfig,
        task: ExecuteTask,
        tx: mpsc::UnboundedSender<Value>,
    ) {
        if self
            .inner
            .running_task
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .is_some()
        {
            send_log(&tx, &task, "设备已有任务运行中", "error");
            send_progress(&tx, &task, 0, "failed");
            return;
        }
        set_mutex(&self.inner.running_task, Some(task.task_id.clone()));
        set_mutex(&self.inner.running_dev_tool, Some(task.tool.clone()));
        let result = self.execute_task_inner(&config, &task, &tx).await;
        if let Err(error) = result {
            send_log(&tx, &task, &error, "error");
            send_progress(&tx, &task, 0, "failed");
            set_mutex(&self.inner.last_error, Some(error));
        }
        set_mutex(&self.inner.running_task, None);
        set_mutex(&self.inner.running_dev_tool, None);
    }

    async fn execute_task_inner(
        &self,
        config: &AgentConfig,
        task: &ExecuteTask,
        tx: &mpsc::UnboundedSender<Value>,
    ) -> Result<(), String> {
        validate_task(task)?;
        let task_dir = PathBuf::from(&config.workspace_root).join(safe_component(&task.task_id));
        if task_dir.exists() {
            tokio::fs::remove_dir_all(&task_dir)
                .await
                .map_err(|error| format!("清理旧工作区失败: {error}"))?;
        }
        if let Some(parent) = task_dir.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("创建工作区失败: {error}"))?;
        }

        send_log(tx, task, "正在克隆仓库并准备独立工作分支", "info");
        send_progress(tx, task, 10, "running");
        run_command(
            None,
            "git",
            &[
                "clone",
                "--branch",
                &task.base_branch,
                "--single-branch",
                &task.repo_url,
                task_dir.to_string_lossy().as_ref(),
            ],
        )
        .await?;
        run_command(
            Some(&task_dir),
            "git",
            &["checkout", "-b", &task.work_branch],
        )
        .await?;
        send_progress(tx, task, 25, "running");

        let dev_tool = task.tool.as_str();
        let prompt = format!(
            "完成以下分布式子任务。直接在当前仓库修改代码，运行必要检查，不要只给建议。\n任务: {}\n要求: {}\n工作分支: {}\n开发工具: {}\n完成后总结修改和验证结果。",
            task.title, task.description, task.work_branch, dev_tool
        );

        match dev_tool {
            "cursor" => {
                send_log(tx, task, "Cursor Agent 正在 headless 模式分析并修改代码", "info");
                send_progress(tx, task, 40, "running");
                let output = run_cursor_agent(&task_dir, &prompt).await?;
                if !output.trim().is_empty() {
                    send_log(tx, task, &truncate(&output, 4000), "info");
                }
            }
            "codex" => {
                send_log(tx, task, "Codex CLI 正在设备本地分析并修改代码", "info");
                send_progress(tx, task, 40, "running");
                let output = run_codex_agent(&task_dir, &prompt).await?;
                if !output.trim().is_empty() {
                    send_log(tx, task, &truncate(&output, 4000), "info");
                }
            }
            _ => {
                if matches!(dev_tool, "trae" | "claude_code") {
                    match launch_tool(dev_tool, &task_dir) {
                        Ok(()) => send_log(tx, task, &format!("已使用 {dev_tool} 打开工作区"), "info"),
                        Err(error) => send_log(
                            tx,
                            task,
                            &format!("{dev_tool} 启动失败，但继续自动编码: {error}"),
                            "warn",
                        ),
                    }
                }
                send_log(
                    tx,
                    task,
                    &format!("使用 {dev_tool} 工作流 + Codex CLI 自动改码"),
                    "info",
                );
                send_progress(tx, task, 40, "running");
                let output = run_codex_agent(&task_dir, &prompt).await?;
                if !output.trim().is_empty() {
                    send_log(tx, task, &truncate(&output, 4000), "info");
                }
            }
        }
        send_progress(tx, task, 80, "running");

        run_command(
            Some(&task_dir),
            "git",
            &["config", "user.name", "DevFleet Agent"],
        )
        .await?;
        run_command(
            Some(&task_dir),
            "git",
            &["config", "user.email", "agent@devfleet.local"],
        )
        .await?;
        run_command(Some(&task_dir), "git", &["add", "-A"]).await?;
        let changes = run_command(Some(&task_dir), "git", &["status", "--porcelain"]).await?;
        if changes.trim().is_empty() {
            return Err("自动执行器没有产生代码变更".to_string());
        }
        run_command(
            Some(&task_dir),
            "git",
            &["commit", "-m", &format!("devfleet: {}", task.title)],
        )
        .await?;
        send_log(tx, task, "本地提交完成，正在推送远程分支", "info");
        send_progress(tx, task, 90, "running");
        run_command(
            Some(&task_dir),
            "git",
            &["push", "-u", "origin", &task.work_branch],
        )
        .await?;
        let sha = run_command(Some(&task_dir), "git", &["rev-parse", "HEAD"]).await?;
        send_log(
            tx,
            task,
            &format!("分支已推送，提交: {}", sha.trim()),
            "info",
        );
        send_progress(tx, task, 100, "completed");
        Ok(())
    }
}

#[tauri::command]
pub async fn agent_bind(
    state: State<'_, AgentState>,
    api_base_url: String,
    bind_code: String,
    device_name: String,
    workspace_root: String,
) -> Result<AgentStatus, String> {
    let api_base_url = api_base_url.trim_end_matches('/').to_string();
    let parsed_url =
        url::Url::parse(&api_base_url).map_err(|_| "服务器地址格式无效".to_string())?;
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err("服务器地址必须以 http:// 或 https:// 开头".to_string());
    }
    if bind_code.trim().len() != 6 {
        return Err("绑定码必须为 6 位".to_string());
    }
    if device_name.trim().is_empty() {
        return Err("设备名称不能为空".to_string());
    }
    let workspace_root = workspace_root.trim().to_string();
    if workspace_root.is_empty() || !Path::new(&workspace_root).is_absolute() {
        return Err("工作目录必须是绝对路径".to_string());
    }
    let response = reqwest::Client::new()
        .post(format!("{api_base_url}/api/devices/activate"))
        .json(&json!({ "bindCode": bind_code.trim().to_uppercase(), "deviceName": device_name }))
        .send()
        .await
        .map_err(|error| format!("绑定请求失败: {error}"))?;
    if !response.status().is_success() {
        let error = response
            .json::<Value>()
            .await
            .ok()
            .and_then(|body| {
                body.get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "绑定失败".to_string());
        return Err(error);
    }
    let activation = response
        .json::<ActivationResponse>()
        .await
        .map_err(|error| format!("绑定响应无效: {error}"))?;
    let config = AgentConfig {
        api_base_url,
        device_token: activation.device_token,
        device_id: activation.device.id,
        device_name: activation.device.name,
        controller_id: activation.controller.id,
        controller_email: activation.controller.email,
        controller_device_id: activation
            .controller
            .primary_device
            .as_ref()
            .map(|device| device.id.clone()),
        controller_device_name: activation
            .controller
            .primary_device
            .map(|device| device.name),
        workspace_root,
        dev_tool: activation
            .device
            .dev_tool
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "trae".to_string()),
        default_editor: activation
            .device
            .dev_tool
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "trae".to_string()),
        executor: "codex".to_string(),
    };
    state.save_config(&config)?;
    set_mutex(&state.inner.config, Some(config));
    state.start();
    agent_status(state).await
}

#[tauri::command]
pub async fn agent_status(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    Ok(AgentStatus {
        configured: state
            .inner
            .config
            .lock()
            .map(|value| value.is_some())
            .unwrap_or(false),
        connected: state
            .inner
            .connected
            .lock()
            .map(|value| *value)
            .unwrap_or(false),
        config: state
            .inner
            .config
            .lock()
            .ok()
            .and_then(|value| value.clone()),
        tools: state
            .inner
            .tools
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default(),
        running_task: state
            .inner
            .running_task
            .lock()
            .ok()
            .and_then(|value| value.clone()),
        last_error: state
            .inner
            .last_error
            .lock()
            .ok()
            .and_then(|value| value.clone()),
    })
}

#[tauri::command]
pub async fn agent_start(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    if state
        .inner
        .config
        .lock()
        .map(|value| value.is_none())
        .unwrap_or(true)
    {
        return Err("请先绑定本机".to_string());
    }
    state.start();
    agent_status(state).await
}

#[tauri::command]
pub async fn agent_stop(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    state.stop();
    agent_status(state).await
}

#[tauri::command]
pub async fn agent_unbind(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    let config = state
        .inner
        .config
        .lock()
        .ok()
        .and_then(|value| value.clone());
    if let Some(config) = config {
        let response = reqwest::Client::new()
            .post(format!(
                "{}/api/devices/deactivate",
                config.api_base_url.trim_end_matches('/')
            ))
            .json(&json!({ "deviceToken": config.device_token }))
            .send()
            .await
            .map_err(|error| format!("服务端解除绑定失败: {error}"))?;
        if !response.status().is_success() && response.status().as_u16() != 404 {
            return Err(format!("服务端解除绑定失败: HTTP {}", response.status()));
        }
    }
    state.stop();
    if state.inner.config_path.exists() {
        std::fs::remove_file(&state.inner.config_path).map_err(|error| error.to_string())?;
    }
    set_mutex(&state.inner.config, None);
    agent_status(state).await
}

#[tauri::command]
pub async fn agent_open_tool(tool: String, workspace: String) -> Result<(), String> {
    launch_tool(&tool, Path::new(&workspace))
}

pub fn start_saved_agent(state: &AgentState) {
    if state
        .inner
        .config
        .lock()
        .map(|value| value.is_some())
        .unwrap_or(false)
    {
        state.start();
    }
}

fn set_mutex<T>(mutex: &Mutex<T>, value: T) {
    if let Ok(mut target) = mutex.lock() {
        *target = value;
    }
}

fn scan_tools(
    current_task: Option<&str>,
    active_dev_tool: Option<&str>,
) -> Vec<LocalToolStatus> {
    let processes = process_list();
    ["trae", "codex", "cursor", "claude_code"]
        .into_iter()
        .map(|name| {
            let executable = if name == "cursor" {
                resolve_cursor_agent()
                    .map(|(program, _)| program)
                    .or_else(|| find_executable("cursor"))
            } else {
                find_executable(name)
            };
            let process_names: &[&str] = match name {
                "claude_code" => &["claude", "claude.exe"],
                "trae" => &["trae", "trae.exe"],
                "cursor" => &["cursor", "cursor.exe", "agent"],
                _ => &["codex", "codex.exe"],
            };
            let running = process_names
                .iter()
                .any(|process| processes.contains(&process.to_lowercase()));
            let is_active = current_task.is_some() && active_dev_tool == Some(name);
            LocalToolStatus {
                tool_name: name.to_string(),
                status: if is_active {
                    "running"
                } else if running {
                    "running"
                } else if executable.is_some() {
                    "idle"
                } else {
                    "not_installed"
                }
                .to_string(),
                installed: executable.is_some(),
                executable,
                current_task: if is_active {
                    current_task.map(str::to_string)
                } else {
                    None
                },
            }
        })
        .collect()
}

fn process_list() -> String {
    #[cfg(target_os = "windows")]
    let output = StdCommand::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output();
    #[cfg(not(target_os = "windows"))]
    let output = StdCommand::new("ps").args(["-A", "-o", "comm="]).output();
    output
        .map(|result| String::from_utf8_lossy(&result.stdout).to_lowercase())
        .unwrap_or_default()
}

fn find_executable(tool: &str) -> Option<String> {
    let binary = match tool {
        "claude_code" => "claude",
        other => other,
    };
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = StdCommand::new("where").arg(binary).output() {
            if output.status.success() {
                if let Some(path) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    return Some(path.trim().to_string());
                }
            }
        }
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let program_files = std::env::var("ProgramFiles").unwrap_or_default();
        let candidates = match tool {
            "trae" => vec![
                format!("{local}\\Programs\\Trae\\Trae.exe"),
                format!("{local}\\Programs\\trae\\Trae.exe"),
                format!("{program_files}\\Trae\\Trae.exe"),
            ],
            "cursor" => vec![format!("{local}\\Programs\\cursor\\Cursor.exe")],
            _ => vec![],
        };
        return candidates.into_iter().find(|path| Path::new(path).exists());
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = StdCommand::new("which").arg(binary).output() {
            if output.status.success() {
                return Some(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
        }
        #[cfg(target_os = "macos")]
        {
            let candidates = match tool {
                "trae" => vec!["/Applications/Trae.app/Contents/MacOS/Trae"],
                "cursor" => vec!["/Applications/Cursor.app/Contents/MacOS/Cursor"],
                _ => vec![],
            };
            if let Some(path) = candidates.into_iter().find(|path| Path::new(path).exists()) {
                return Some(path.to_string());
            }
        }
        None
    }
}

fn launch_tool(tool: &str, workspace: &Path) -> Result<(), String> {
    let executable = find_executable(tool).ok_or_else(|| format!("未找到 {tool} 可执行文件"))?;
    StdCommand::new(executable)
        .arg(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// 解析 Cursor Agent CLI：`agent` 独立二进制，或 `cursor agent` 子命令。
fn resolve_cursor_agent() -> Option<(String, Vec<String>)> {
    if let Some(path) = find_binary_in_path("agent") {
        return Some((path, Vec::new()));
    }
    if let Some(path) = find_binary_in_path("cursor") {
        return Some((path, vec!["agent".to_string()]));
    }
    None
}

async fn run_cursor_agent(cwd: &Path, prompt: &str) -> Result<String, String> {
    let (program, prefix) = resolve_cursor_agent().ok_or_else(|| {
        "未找到 Cursor Agent CLI。请安装：curl https://cursor.com/install -fsS | bash，并执行 agent login 或设置 CURSOR_API_KEY".to_string()
    })?;
    let mut args: Vec<String> = prefix;
    args.extend([
        "-p".to_string(),
        "--force".to_string(),
        "--trust".to_string(),
        "--output-format".to_string(),
        "text".to_string(),
        prompt.to_string(),
    ]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_command(Some(cwd), &program, &arg_refs).await
}

async fn run_codex_agent(cwd: &Path, prompt: &str) -> Result<String, String> {
    let codex = find_executable("codex").ok_or_else(|| {
        "未找到 Codex CLI。目标设备需安装并登录 Codex（codex login）".to_string()
    })?;
    run_command(
        Some(cwd),
        &codex,
        &[
            "exec",
            "--sandbox",
            "workspace-write",
            "--ephemeral",
            prompt,
        ],
    )
    .await
}

fn find_binary_in_path(binary: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = StdCommand::new("where").arg(binary).output() {
            if output.status.success() {
                if let Some(path) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let trimmed = path.trim().to_string();
                    if !trimmed.is_empty() {
                        return Some(trimmed);
                    }
                }
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = StdCommand::new("which").arg(binary).output() {
            if output.status.success() {
                let trimmed = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !trimmed.is_empty() {
                    return Some(trimmed);
                }
            }
        }
        None
    }
}

async fn run_command(cwd: Option<&Path>, program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .await
        .map_err(|error| format!("无法启动 {program}: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(if stdout.trim().is_empty() {
            stderr
        } else {
            stdout
        })
    } else {
        Err(format!(
            "命令失败: {program} {}\n{}",
            args.join(" "),
            truncate(&stderr, 4000)
        ))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeTaskResult {
    pub success: bool,
    pub commit: String,
    pub branch: String,
    pub merged_branches: Vec<String>,
    pub pushed: bool,
}

#[tauri::command]
pub async fn agent_merge_task(
    workspace_path: String,
    branch: String,
    subtask_branches: Vec<String>,
    push: bool,
) -> Result<MergeTaskResult, String> {
    let workspace = workspace_path.trim();
    if workspace.is_empty() || !Path::new(workspace).is_absolute() {
        return Err("工作区必须是绝对路径".to_string());
    }
    if subtask_branches.is_empty() {
        return Err("没有可合并的子任务分支".to_string());
    }
    for branch_name in &subtask_branches {
        if branch_name.is_empty()
            || branch_name.contains("..")
            || !branch_name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "/_-".contains(ch) || ch == '.')
        {
            return Err(format!("不安全的 Git 分支名: {branch_name}"));
        }
    }

    let cwd = Path::new(workspace);
    run_command(Some(cwd), "git", &["rev-parse", "--is-inside-work-tree"]).await?;
    let dirty = run_command(Some(cwd), "git", &["status", "--porcelain"]).await?;
    if !dirty.trim().is_empty() {
        return Err("主设备工作区存在未提交修改，请先提交或暂存后再合并".to_string());
    }

    run_command(Some(cwd), "git", &["fetch", "--all", "--prune"]).await?;
    run_command(Some(cwd), "git", &["checkout", &branch]).await?;
    run_command(
        Some(cwd),
        "git",
        &["pull", "--ff-only", "origin", &branch],
    )
    .await?;

    for branch_name in &subtask_branches {
        match run_command(
            Some(cwd),
            "git",
            &["merge", "--no-edit", &format!("origin/{branch_name}")],
        )
        .await
        {
            Ok(_) => {}
            Err(error) => {
                let _ = run_command(Some(cwd), "git", &["merge", "--abort"]).await;
                return Err(format!("合并 origin/{branch_name} 失败: {error}"));
            }
        }
    }

    if push {
        run_command(Some(cwd), "git", &["push", "origin", &branch]).await?;
    }
    let commit = run_command(Some(cwd), "git", &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();

    Ok(MergeTaskResult {
        success: true,
        commit,
        branch: branch.clone(),
        merged_branches: subtask_branches,
        pushed: push,
    })
}

fn validate_task(task: &ExecuteTask) -> Result<(), String> {
    if !(task.repo_url.starts_with("https://")
        || task.repo_url.starts_with("http://")
        || task.repo_url.starts_with("git@"))
    {
        return Err("仓库地址必须是 HTTP(S) 或 SSH Git 地址".to_string());
    }
    for branch in [&task.base_branch, &task.work_branch] {
        if branch.is_empty()
            || branch.contains("..")
            || !branch
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "/_-".contains(ch) || ch == '.')
        {
            return Err(format!("不安全的 Git 分支名: {branch}"));
        }
    }
    Ok(())
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect()
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn send_log(tx: &mpsc::UnboundedSender<Value>, task: &ExecuteTask, content: &str, level: &str) {
    let _ = tx.send(json!({ "type": "task_log", "task_id": task.task_id, "subtask_id": task.subtask_id, "content": content, "level": level }));
}

fn send_progress(
    tx: &mpsc::UnboundedSender<Value>,
    task: &ExecuteTask,
    progress: u8,
    status: &str,
) {
    let _ = tx.send(json!({ "type": "task_progress", "task_id": task.task_id, "subtask_id": task.subtask_id, "progress": progress, "status": status }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(repo_url: &str, branch: &str) -> ExecuteTask {
        ExecuteTask {
            task_id: "task-1".to_string(),
            subtask_id: "sub-1".to_string(),
            title: "test".to_string(),
            description: "test".to_string(),
            repo_url: repo_url.to_string(),
            base_branch: branch.to_string(),
            work_branch: "devfleet/trae/sub-1".to_string(),
            tool: "trae".to_string(),
        }
    }

    #[test]
    fn accepts_git_repositories_and_safe_branches() {
        assert!(validate_task(&task("https://github.com/example/repo.git", "main")).is_ok());
        assert!(validate_task(&task("git@github.com:example/repo.git", "release/v1.0")).is_ok());
    }

    #[test]
    fn rejects_local_paths_and_unsafe_branches() {
        assert!(validate_task(&task("C:\\secret", "main")).is_err());
        assert!(validate_task(&task("https://github.com/example/repo.git", "../../main")).is_err());
    }
}
