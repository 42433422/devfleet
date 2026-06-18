use crate::computer_use;
use crate::process_util::merge_no_proxy_entries;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    net::IpAddr,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    net::TcpStream,
    process::{ChildStderr, ChildStdout, Command},
    sync::mpsc,
    time::{self, Duration},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

/// 绑定/激活走局域网 IP，必须禁用系统 HTTP 代理，否则 reqwest 会把 192.168.x.x 转发到代理导致失败
fn lan_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(20))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

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

#[derive(Debug, Clone, Deserialize)]
struct ExecuteCommand {
    command_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    shell: String,
    script: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
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
    pending_task_reports: Mutex<VecDeque<PendingTaskReport>>,
    generation: AtomicU64,
    loop_running: AtomicBool,
    paused: AtomicBool,
}

#[derive(Debug, Clone)]
struct PendingTaskReport {
    task_id: String,
    subtask_id: String,
    progress: Option<u8>,
    status: Option<String>,
    content: String,
    level: String,
}

#[derive(Clone)]
struct TaskEventSink {
    tx: mpsc::UnboundedSender<Value>,
    inner: Arc<AgentInner>,
}

impl TaskEventSink {
    fn new(tx: mpsc::UnboundedSender<Value>, inner: Arc<AgentInner>) -> Self {
        Self { tx, inner }
    }

    fn send_or_queue(&self, payload: Value, fallback: PendingTaskReport) {
        if self.tx.send(payload).is_ok() {
            return;
        }
        if let Ok(mut queue) = self.inner.pending_task_reports.lock() {
            queue.push_back(fallback);
        }
    }
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
                pending_task_reports: Mutex::new(VecDeque::new()),
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

            if let Some(reason) = self
                .check_api_link_health(&config.api_base_url, &config.device_id)
                .await
            {
                set_mutex(
                    &self.inner.last_error,
                    Some(format!("链路不可用（API 健康检查失败: {reason}）")),
                );
                set_mutex(&self.inner.connected, false);
                if self.inner.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                if !self.interruptible_sleep(generation, backoff_secs).await {
                    return;
                }
                backoff_secs = (backoff_secs * 2).min(60);
                continue;
            }

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

    async fn check_api_link_health(&self, api_base_url: &str, _device_id: &str) -> Option<String> {
        let base = api_base_url.trim_end_matches('/');
        let url = format!("{}/api/health", base);
        let response = lan_http_client().get(url).send().await;
        match response {
            Ok(res) => {
                if !res.status().is_success() {
                    return Some(format!("HTTP {}", res.status()));
                }
                let payload = res.json::<serde_json::Value>().await;
                if let Ok(payload) = payload {
                    let success = payload
                        .get("success")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if !success {
                        return Some("服务端健康检查返回失败（success=false）".into());
                    }
                    return None;
                }
                Some("健康检查响应解析失败".to_string())
            }
            Err(error) => Some(format!("{error}")),
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

    fn enqueue_pending_task_report(&self, report: PendingTaskReport) {
        if let Ok(mut queue) = self.inner.pending_task_reports.lock() {
            queue.push_back(report);
        }
    }

    async fn post_task_report(
        &self,
        config: &AgentConfig,
        report: &PendingTaskReport,
    ) -> Result<(), String> {
        let url = format!(
            "{}/api/devices/me/task-report",
            config.api_base_url.trim_end_matches('/')
        );
        let response = lan_http_client()
            .post(url)
            .bearer_auth(&config.device_token)
            .json(&json!({
                "task_id": report.task_id,
                "subtask_id": report.subtask_id,
                "progress": report.progress,
                "status": report.status,
                "content": report.content,
                "level": report.level,
            }))
            .send()
            .await
            .map_err(|error| format!("上报任务状态失败: {error}"))?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        Err(format!(
            "上报任务状态失败: HTTP {} {}",
            status,
            truncate(&body, 500)
        ))
    }

    async fn flush_pending_task_reports(&self, config: &AgentConfig) {
        loop {
            let report = {
                let mut queue = match self.inner.pending_task_reports.lock() {
                    Ok(queue) => queue,
                    Err(_) => return,
                };
                queue.pop_front()
            };
            let Some(report) = report else {
                return;
            };
            if let Err(error) = self.post_task_report(config, &report).await {
                log::warn!(
                    "[DevFleet] failed to flush pending task report {} / {}: {}",
                    report.task_id,
                    report.subtask_id,
                    error
                );
                if let Ok(mut queue) = self.inner.pending_task_reports.lock() {
                    queue.push_front(report);
                }
                return;
            }
        }
    }

    async fn report_terminal_task_status(
        &self,
        config: &AgentConfig,
        task: &ExecuteTask,
        progress: u8,
        status: &str,
        content: String,
        level: &str,
    ) {
        let report = PendingTaskReport {
            task_id: task.task_id.clone(),
            subtask_id: task.subtask_id.clone(),
            progress: Some(progress),
            status: Some(status.to_string()),
            content,
            level: level.to_string(),
        };
        if let Err(error) = self.post_task_report(config, &report).await {
            log::warn!(
                "[DevFleet] terminal task report queued for retry {} / {}: {}",
                task.task_id,
                task.subtask_id,
                error
            );
            self.enqueue_pending_task_report(report);
        }
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

        let publish_tool_status = |state: &Self| -> Result<Value, String> {
            let running_task = state
                .inner
                .running_task
                .lock()
                .ok()
                .and_then(|value| value.clone());
            let running_dev_tool = state
                .inner
                .running_dev_tool
                .lock()
                .ok()
                .and_then(|value| value.clone());
            let tools = scan_tools(running_task.as_deref(), running_dev_tool.as_deref());
            set_mutex(&state.inner.tools, tools.clone());
            Ok(json!({
              "type": "tool_status",
              "tools": tools.into_iter().map(|tool| json!({
                "tool_name": tool.tool_name,
                "status": tool.status,
                "current_task": tool.current_task,
              })).collect::<Vec<_>>(),
              "capabilities": probe_capabilities(),
            }))
        };

        let initial_status = publish_tool_status(self)?;
        writer
            .send(Message::Text(initial_status.to_string().into()))
            .await
            .map_err(|error| error.to_string())?;
        self.flush_pending_task_reports(&config).await;

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
                let payload = publish_tool_status(self)?;
                writer.send(Message::Text(payload.to_string().into())).await.map_err(|error| error.to_string())?;
                self.flush_pending_task_reports(&config).await;
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
                      let task_tx = TaskEventSink::new(outbound_tx.clone(), state.inner.clone());
                      tauri::async_runtime::spawn(async move {
                        state.execute_task(task_config, task, task_tx).await;
                      });
                      continue;
                    }
                    if value.get("type").and_then(Value::as_str) == Some("execute_command") {
                      let command: ExecuteCommand = serde_json::from_value(value).map_err(|error| error.to_string())?;
                      let state = self.clone();
                      let command_tx = outbound_tx.clone();
                      tauri::async_runtime::spawn(async move {
                        state.execute_command(command, command_tx).await;
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

    async fn execute_task(&self, config: AgentConfig, task: ExecuteTask, tx: TaskEventSink) {
        let claimed = {
            let mut guard = match self.inner.running_task.lock() {
                Ok(guard) => guard,
                Err(_) => {
                    send_log(&tx, &task, "设备状态锁不可用", "error");
                    send_progress(&tx, &task, 0, "failed");
                    return;
                }
            };
            if guard.is_some() {
                false
            } else {
                *guard = Some(task.task_id.clone());
                set_mutex(&self.inner.running_dev_tool, Some(task.tool.clone()));
                true
            }
        };
        if !claimed {
            send_log(&tx, &task, "设备已有任务运行中", "error");
            send_progress(&tx, &task, 0, "failed");
            return;
        }

        let task_id = task.task_id.clone();
        let result = self.execute_task_inner(&config, &task, &tx).await;
        match result {
            Ok(final_sha) => {
                self.report_terminal_task_status(
                    &config,
                    &task,
                    100,
                    "completed",
                    format!("任务完成，最终提交: {final_sha}"),
                    "info",
                )
                .await;
            }
            Err(error) => {
                set_mutex(&self.inner.last_error, Some(error.clone()));
                self.report_terminal_task_status(&config, &task, 0, "failed", error, "error")
                    .await;
            }
        }

        if let Ok(mut guard) = self.inner.running_task.lock() {
            if guard.as_deref() == Some(task_id.as_str()) {
                *guard = None;
            }
        }
        set_mutex(&self.inner.running_dev_tool, None);
    }

    async fn execute_command(
        &self,
        command: ExecuteCommand,
        tx: mpsc::UnboundedSender<Value>,
    ) {
        let command_id = command.command_id.clone();
        let claimed = {
            let mut guard = match self.inner.running_task.lock() {
                Ok(guard) => guard,
                Err(_) => {
                    send_command_result(
                        &tx,
                        &command,
                        "failed",
                        None,
                        "",
                        "",
                        "设备状态锁不可用",
                    );
                    return;
                }
            };
            if guard.is_some() {
                false
            } else {
                *guard = Some(format!("remote-command:{command_id}"));
                true
            }
        };
        if !claimed {
            send_command_result(
                &tx,
                &command,
                "failed",
                None,
                "",
                "",
                "设备已有任务或命令运行中",
            );
            return;
        }

        let result = self.execute_command_inner(&command, &tx).await;
        match result {
            Ok(output) => {
                send_command_result(&tx, &command, "completed", Some(0), &output, "", "");
            }
            Err(error) => {
                set_mutex(&self.inner.last_error, Some(error.clone()));
                send_command_result(&tx, &command, "failed", None, "", "", &error);
            }
        }

        if let Ok(mut guard) = self.inner.running_task.lock() {
            let expected = format!("remote-command:{command_id}");
            if guard.as_deref() == Some(expected.as_str()) {
                *guard = None;
            }
        }
    }

    async fn execute_command_inner(
        &self,
        command: &ExecuteCommand,
        tx: &mpsc::UnboundedSender<Value>,
    ) -> Result<String, String> {
        let script = command.script.trim();
        if script.is_empty() {
            return Err("远程命令脚本为空".to_string());
        }
        let title = if command.title.trim().is_empty() {
            "远程命令"
        } else {
            command.title.trim()
        };
        send_command_log(
            tx,
            &command.command_id,
            &format!("开始执行：{title}"),
            "info",
        );
        let shell = normalize_remote_shell(&command.shell);
        let (program, args) = remote_shell_invocation(&shell, script);
        let timeout = Duration::from_secs(
            command
                .timeout_seconds
                .unwrap_or(300)
                .clamp(5, 1_800),
        );
        let cwd_path = command
            .cwd
            .as_ref()
            .map(|value| PathBuf::from(value.trim()))
            .filter(|path| !path.as_os_str().is_empty());
        if let Some(path) = cwd_path.as_ref() {
            if !path.exists() {
                return Err(format!("远程命令 cwd 不存在: {}", path.display()));
            }
        }
        send_command_log(
            tx,
            &command.command_id,
            &format!(
                "执行器: {} {}",
                program,
                args.iter()
                    .map(|arg| truncate(arg, 160))
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
            "info",
        );
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = run_command_timed(
            cwd_path.as_deref(),
            &program,
            &arg_refs,
            Some(timeout),
        )
        .await?;
        if !output.trim().is_empty() {
            send_command_log(
                tx,
                &command.command_id,
                &format!("命令输出: {}", truncate(output.trim(), 4000)),
                "info",
            );
        }
        Ok(output)
    }

    async fn execute_task_inner(
        &self,
        config: &AgentConfig,
        task: &ExecuteTask,
        tx: &TaskEventSink,
    ) -> Result<String, String> {
        validate_task(task)?;
        if !task.repo_url.trim().is_empty() {
            send_log(tx, task, "执行前检查仓库链路可达性", "info");
            Self::assert_repo_reachability(task.repo_url.trim()).await?;
        }
        let task_dir = self.prepare_task_workspace(config, task, tx).await?;
        let mut baseline_head = git_current_head(&task_dir).await?;
        send_progress(tx, task, 25, "running");

        let dev_tool = task.tool.as_str();
        if dev_tool != "trae" {
            self.auto_start_assigned_tool(dev_tool, &task_dir, tx, task);
        }

        let prompt = format!(
            "完成以下分布式子任务。直接在当前仓库修改代码，运行必要检查，不要只给建议。\n任务: {}\n要求: {}\n工作分支: {}\n开发工具: {}\n完成后总结修改和验证结果。",
            task.title, task.description, task.work_branch, dev_tool
        );

        match dev_tool {
            "cursor" => {
                send_log(
                    tx,
                    task,
                    "Cursor Agent 正在 headless 模式分析并修改代码",
                    "info",
                );
                send_progress(tx, task, 40, "running");
                let (program, prefix) =
                    resolve_cursor_agent().ok_or_else(cursor_agent_missing_message)?;
                let mut args = prefix;
                args.extend([
                    "-p".to_string(),
                    "--force".to_string(),
                    "--trust".to_string(),
                    "--output-format".to_string(),
                    "text".to_string(),
                    prompt.to_string(),
                ]);
                let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
                let output = run_logged_command(
                    task,
                    tx,
                    Some(&task_dir),
                    "cursor",
                    &program,
                    &arg_refs,
                    Some(ai_agent_command_timeout()),
                )
                .await?;
                if !output.trim().is_empty() {
                    send_log(tx, task, &truncate(&output, 4000), "info");
                }
            }
            "codex" => {
                send_log(tx, task, "Codex CLI 正在设备本地分析并修改代码", "info");
                send_progress(tx, task, 40, "running");
                let codex = resolve_codex_cli()?;
                send_log(tx, task, &format!("Codex 解析路径: {codex}"), "info");
                let output = run_logged_command(
                    task,
                    tx,
                    Some(&task_dir),
                    "codex",
                    &codex,
                    &[
                        "exec",
                        "--sandbox",
                        "workspace-write",
                        "--ephemeral",
                        &prompt,
                    ],
                    Some(ai_agent_command_timeout()),
                )
                .await?;
                if !output.trim().is_empty() {
                    send_log(tx, task, &truncate(&output, 4000), "info");
                }
            }
            "trae" => {
                send_log(
                    tx,
                    task,
                    "[pipeline:trae] Trae 混合模式：CLI 优先，Computer Use 兜底",
                    "info",
                );
                send_progress(tx, task, 30, "running");

                let devfleet_dir = task_dir.join(".devfleet");
                tokio::fs::create_dir_all(&devfleet_dir)
                    .await
                    .map_err(|error| format!("创建 .devfleet 目录失败: {error}"))?;
                let task_md = format!(
                    "# 排比 Para 任务\n\n## 标题\n{}\n\n## 要求\n{}\n\n## 工作分支\n{}\n\n完成后总结修改和验证结果。",
                    task.title, task.description, task.work_branch
                );
                tokio::fs::write(devfleet_dir.join("TASK.md"), &task_md)
                    .await
                    .map_err(|error| format!("写入任务文件失败: {error}"))?;

                let trae_dir = task_dir.join(".trae");
                tokio::fs::create_dir_all(&trae_dir)
                    .await
                    .map_err(|error| format!("创建 .trae 目录失败: {error}"))?;
                let mcp_json =
                    build_trae_project_mcp_json(&config.api_base_url, &config.device_token);
                tokio::fs::write(trae_dir.join("mcp.json"), &mcp_json)
                    .await
                    .map_err(|error| format!("写入 MCP 配置失败: {error}"))?;

                establish_trae_git_baseline(&task_dir, tx, task).await?;
                baseline_head = git_current_head(&task_dir).await?;

                let _ = computer_use::prepare_trae_workspace_settings(Path::new(
                    &config.workspace_root,
                ));
                let _ = computer_use::prepare_trae_workspace_settings(&task_dir);

                let trae_prompt = if task.description.trim().is_empty() {
                    format!(
                        "排比 Para 子任务：{}\n工作分支：{}\n\n{}",
                        task.title.trim(),
                        task.work_branch.trim(),
                        prompt.trim()
                    )
                } else {
                    format!(
                        "排比 Para 子任务：{}\n工作分支：{}\n\n{}",
                        task.title.trim(),
                        task.work_branch.trim(),
                        task.description.trim()
                    )
                };

                let mut dispatch_ok = false;

                send_log(
                    tx,
                    task,
                    "[pipeline:trae_cli] 优先尝试 TRAE Agent CLI（trae run / trae-cli run）…",
                    "info",
                );
                match run_trae_agent_cli(&task_dir, &trae_prompt).await {
                    Ok((label, output)) => {
                        dispatch_ok = true;
                        send_log(
                            tx,
                            task,
                            &format!("[pipeline:trae_cli] {label} 已完成"),
                            "info",
                        );
                        if !output.trim().is_empty() {
                            send_log(tx, task, &truncate(&output, 4000), "info");
                        }
                    }
                    Err(cli_error) => {
                        send_log(
                            tx,
                            task,
                            &format!(
                                "[pipeline:trae_cli] CLI 不可用或执行失败，回退 Computer Use: {cli_error}"
                            ),
                            "warn",
                        );
                    }
                }

                if !dispatch_ok {
                    dispatch_ok =
                        execute_trae_computer_use_fallback(&task_dir, &trae_prompt, tx, task).await;
                }

                if !dispatch_ok {
                    send_log(
                        tx,
                        task,
                        "[pipeline:trae] CLI 与 Computer Use 均未成功派发，仍将等待工作区代码变更…",
                        "warn",
                    );
                }

                send_log(
                    tx,
                    task,
                    "[pipeline:trae] 任务已写入 .devfleet/TASK.md，等待 Trae Agent 改码…",
                    "info",
                );
                send_progress(tx, task, 40, "running");

                send_log(
                    tx,
                    task,
                    "[pipeline:wait] 等待 Trae Agent 修改代码...",
                    "info",
                );
                let timeout_secs: u64 = 600;
                let poll_interval_secs: u64 = 10;
                let start = std::time::Instant::now();
                let mut has_changes = false;

                while start.elapsed().as_secs() < timeout_secs {
                    tokio::time::sleep(Duration::from_secs(poll_interval_secs)).await;
                    if git_has_meaningful_changes(&task_dir).await? {
                        has_changes = true;
                        break;
                    }
                    let elapsed_secs = start.elapsed().as_secs();
                    let progress = 40 + ((elapsed_secs * 40) / timeout_secs).min(40) as u8;
                    send_progress(tx, task, progress, "running");
                }

                if !has_changes {
                    return Err(
                        "等待 Trae Agent 超时，未检测到代码变更（排除 .devfleet/.trae 元数据）"
                            .to_string(),
                    );
                }
                send_log(
                    tx,
                    task,
                    "[pipeline:trae] 检测到 Trae Agent 代码变更",
                    "info",
                );
            }
            _ => {
                if matches!(dev_tool, "claude_code") {
                    match launch_tool(dev_tool, &task_dir) {
                        Ok(()) => {
                            send_log(tx, task, &format!("已使用 {dev_tool} 打开工作区"), "info")
                        }
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
                let codex = resolve_codex_cli()?;
                send_log(tx, task, &format!("Codex 解析路径: {codex}"), "info");
                let output = run_logged_command(
                    task,
                    tx,
                    Some(&task_dir),
                    "codex",
                    &codex,
                    &[
                        "exec",
                        "--sandbox",
                        "workspace-write",
                        "--ephemeral",
                        &prompt,
                    ],
                    Some(ai_agent_command_timeout()),
                )
                .await?;
                if !output.trim().is_empty() {
                    send_log(tx, task, &truncate(&output, 4000), "info");
                }
            }
        }
        send_progress(tx, task, 80, "running");

        send_log(tx, task, "开始 Git 步骤：配置身份信息", "info");
        run_logged_command(
            task,
            tx,
            Some(&task_dir),
            "git",
            "git",
            &["config", "user.name", "Paibi Para Agent"],
            Some(Duration::from_secs(30)),
        )
        .await?;
        run_logged_command(
            task,
            tx,
            Some(&task_dir),
            "git",
            "git",
            &["config", "user.email", "agent@devfleet.local"],
            Some(Duration::from_secs(30)),
        )
        .await?;
        run_logged_command(
            task,
            tx,
            Some(&task_dir),
            "git",
            "git",
            &["add", "-A"],
            Some(Duration::from_secs(60)),
        )
        .await?;
        let changes = run_logged_command(
            task,
            tx,
            Some(&task_dir),
            "git",
            "git",
            &["status", "--porcelain"],
            Some(Duration::from_secs(30)),
        )
        .await?;
        let final_head = git_current_head(&task_dir).await?;
        match determine_git_completion_mode(
            baseline_head.as_deref(),
            final_head.as_deref(),
            &changes,
        ) {
            GitCompletionMode::NoChanges => {
                return Err("自动执行器没有产生代码变更".to_string());
            }
            GitCompletionMode::ReuseExistingCommit => {
                let sha = final_head
                    .ok_or_else(|| "自动执行器已提交，但无法读取最终 HEAD".to_string())?;
                send_log(
                    tx,
                    task,
                    &format!("检测到自动执行器已自行提交，复用现有提交: {sha}"),
                    "info",
                );
                send_progress(tx, task, 90, "running");
                push_branch_if_remote(&task_dir, &task.work_branch, tx, task).await?;
                send_log(
                    tx,
                    task,
                    &format!("分支已就绪，提交: {}", sha.trim()),
                    "info",
                );
                return Ok(sha);
            }
            GitCompletionMode::CommitPendingChanges => {}
        }
        let commit_message = format!("devfleet: {}", task.title);
        send_log(tx, task, &format!("准备提交：{commit_message}"), "info");
        run_logged_command(
            task,
            tx,
            Some(&task_dir),
            "git",
            "git",
            &["commit", "-m", &commit_message],
            Some(Duration::from_secs(120)),
        )
        .await?;
        send_log(tx, task, "本地提交完成", "info");
        send_progress(tx, task, 90, "running");
        push_branch_if_remote(&task_dir, &task.work_branch, tx, task).await?;
        let sha = run_logged_command(
            task,
            tx,
            Some(&task_dir),
            "git",
            "git",
            &["rev-parse", "HEAD"],
            Some(Duration::from_secs(30)),
        )
        .await?;
        send_log(
            tx,
            task,
            &format!("分支已就绪，提交: {}", sha.trim()),
            "info",
        );
        Ok(sha.trim().to_string())
    }

    fn parse_repo_endpoint(repo_url: &str) -> Option<(String, u16)> {
        let trimmed = repo_url.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("file://")
            || Path::new(trimmed).is_absolute()
            || trimmed.starts_with("./")
            || trimmed.starts_with("../")
        {
            return None;
        }

        if trimmed.starts_with("git@") {
            let after_at = trimmed.strip_prefix("git@")?;
            let host = after_at
                .split(':')
                .next()?
                .trim()
                .trim_start_matches('[')
                .trim_end_matches(']');
            if host.is_empty() {
                return None;
            }
            return Some((host.to_string(), 22));
        }

        let parsed = Url::parse(trimmed).ok()?;
        let host = parsed.host_str()?.to_string();
        let port = parsed.port().unwrap_or(match parsed.scheme() {
            "http" => 80,
            "https" => 443,
            "ssh" => 22,
            "git" => 22,
            _ => 22,
        });
        Some((host, port))
    }

    async fn assert_repo_reachability(repo_url: &str) -> Result<(), String> {
        let Some((host, port)) = Self::parse_repo_endpoint(repo_url) else {
            return Ok(());
        };

        let timeout_ms = command_timeout_ms_env("DEVFLEET_REPO_NET_PROBE_MS", 3000);
        let timeout = Duration::from_millis(timeout_ms);
        let probe = time::timeout(timeout, TcpStream::connect(format!("{host}:{port}"))).await;
        match probe {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(format!(
                "仓库链路检查失败（{host}:{port}）：{error}。请确认该端口/防火墙/NAT 可达"
            )),
            Err(_) => Err(format!(
                "仓库链路检查超时（{host}:{port}，{timeout_ms}ms）. 请确认该端口/防火墙/NAT 可达"
            )),
        }
    }

    async fn prepare_task_workspace(
        &self,
        config: &AgentConfig,
        task: &ExecuteTask,
        tx: &TaskEventSink,
    ) -> Result<PathBuf, String> {
        let repo_url = task.repo_url.trim();
        let use_local_only = repo_url.is_empty();
        let task_dir = if use_local_only {
            PathBuf::from(&config.workspace_root)
        } else {
            PathBuf::from(&config.workspace_root).join(safe_component(&task.task_id))
        };

        if use_local_only {
            tokio::fs::create_dir_all(&task_dir)
                .await
                .map_err(|error| format!("创建工作区失败: {error}"))?;
            send_log(tx, task, "未提供远程仓库地址，使用本地工作目录", "info");
            send_progress(tx, task, 10, "running");
            if !task_dir.join(".git").exists() {
                send_log(tx, task, "初始化本地 Git 仓库", "info");
                run_command(Some(&task_dir), "git", &["init"]).await?;
            }
            checkout_work_branch(&task_dir, &task.work_branch, &task.base_branch).await?;
            return Ok(task_dir);
        }

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
        run_git_command(
            None,
            &[
                "clone",
                "--branch",
                &task.base_branch,
                "--single-branch",
                repo_url,
                task_dir.to_string_lossy().as_ref(),
            ],
            Duration::from_secs(600),
        )
        .await?;
        run_git_command(
            Some(&task_dir),
            &["checkout", "-b", &task.work_branch],
            Duration::from_secs(120),
        )
        .await?;
        send_log(
            tx,
            task,
            &format!(
                "仓库克隆完成，工作分支 {} 已就绪（{}）",
                task.work_branch,
                task_dir.display()
            ),
            "info",
        );
        Ok(task_dir)
    }

    fn auto_start_assigned_tool(
        &self,
        dev_tool: &str,
        task_dir: &Path,
        tx: &TaskEventSink,
        task: &ExecuteTask,
    ) {
        if dev_tool == "codex" {
            return;
        }
        if is_tool_process_running(dev_tool) {
            send_log(
                tx,
                task,
                &format!("{dev_tool} 已在运行，跳过自动启动"),
                "info",
            );
            return;
        }
        if !tool_is_available(dev_tool) {
            send_log(
                tx,
                task,
                &format!("未检测到 {dev_tool} 安装路径，继续 headless 自动改码"),
                "warn",
            );
            return;
        }
        match launch_tool_for(dev_tool, task_dir) {
            Ok(()) => send_log(
                tx,
                task,
                &format!("已自动启动 {dev_tool} 并打开工作区"),
                "info",
            ),
            Err(error) => send_log(
                tx,
                task,
                &format!("{dev_tool} 自动启动失败，继续 headless 改码: {error}"),
                "warn",
            ),
        }
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
    let response = lan_http_client()
        .post(format!("{api_base_url}/api/devices/activate"))
        .json(&json!({ "bindCode": bind_code.trim().to_uppercase(), "deviceName": device_name }))
        .send()
        .await
        .map_err(|error| {
            format!(
                "绑定请求失败: {error}。请在工作设备执行 curl {}/api/health 确认能连通主设备",
                api_base_url.trim_end_matches('/')
            )
        })?;
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
        let response = lan_http_client()
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

#[derive(Debug, Deserialize)]
struct GuestAuthResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
struct DevicesListResponse {
    devices: Vec<DeviceSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceSummary {
    #[serde(default)]
    bind_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindCodeResponse {
    bind_code: String,
}

const LOCAL_API_BASE: &str = "http://127.0.0.1:3001";

pub fn try_auto_bind_localhost(_app: &AppHandle, state: &AgentState) {
    if state
        .inner
        .config
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .is_some()
    {
        return;
    }

    for _ in 0..120 {
        if crate::server::is_local_server_healthy() {
            break;
        }
        std::thread::sleep(Duration::from_secs(1) / 2);
    }
    if !crate::server::is_local_server_healthy() {
        log::warn!("[DevFleet] auto-bind skipped: local API server not healthy after 60s");
        return;
    }

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            log::warn!("[DevFleet] auto-bind skipped: HTTP client error: {error}");
            return;
        }
    };

    let guest_token = match client
        .post(format!("{LOCAL_API_BASE}/api/auth/guest"))
        .send()
    {
        Ok(response) if response.status().is_success() => {
            match response.json::<GuestAuthResponse>() {
                Ok(body) => body.token,
                Err(error) => {
                    log::warn!("[DevFleet] auto-bind skipped: guest response invalid: {error}");
                    return;
                }
            }
        }
        Ok(response) => {
            log::warn!(
                "[DevFleet] auto-bind skipped: guest login failed: HTTP {}",
                response.status()
            );
            return;
        }
        Err(error) => {
            log::warn!("[DevFleet] auto-bind skipped: guest login error: {error}");
            return;
        }
    };

    let bind_code = match client
        .get(format!("{LOCAL_API_BASE}/api/devices"))
        .header("Authorization", format!("Bearer {guest_token}"))
        .send()
    {
        Ok(response) if response.status().is_success() => {
            match response.json::<DevicesListResponse>() {
                Ok(body) => body
                    .devices
                    .into_iter()
                    .filter_map(|device| device.bind_code)
                    .find(|code| code.trim().len() == 6),
                Err(error) => {
                    log::warn!("[DevFleet] auto-bind skipped: devices response invalid: {error}");
                    return;
                }
            }
        }
        Ok(response) => {
            log::warn!(
                "[DevFleet] auto-bind skipped: list devices failed: HTTP {}",
                response.status()
            );
            return;
        }
        Err(error) => {
            log::warn!("[DevFleet] auto-bind skipped: list devices error: {error}");
            return;
        }
    };

    let bind_code = match bind_code {
        Some(code) => code,
        None => match client
            .post(format!("{LOCAL_API_BASE}/api/devices/bind"))
            .header("Authorization", format!("Bearer {guest_token}"))
            .json(&json!({ "name": "我的开发设备" }))
            .send()
        {
            Ok(response) if response.status().is_success() => {
                match response.json::<BindCodeResponse>() {
                    Ok(body) => body.bind_code,
                    Err(error) => {
                        log::warn!("[DevFleet] auto-bind skipped: bind response invalid: {error}");
                        return;
                    }
                }
            }
            Ok(response) => {
                log::warn!(
                    "[DevFleet] auto-bind skipped: create bind code failed: HTTP {}",
                    response.status()
                );
                return;
            }
            Err(error) => {
                log::warn!("[DevFleet] auto-bind skipped: create bind code error: {error}");
                return;
            }
        },
    };

    let workspace_root = default_agent_workspace_root();
    if let Err(error) = std::fs::create_dir_all(&workspace_root) {
        log::warn!(
            "[DevFleet] auto-bind skipped: cannot create workspace {}: {error}",
            workspace_root.display()
        );
        return;
    }

    let device_name = local_device_name();
    let activation = match client
        .post(format!("{LOCAL_API_BASE}/api/devices/activate"))
        .json(&json!({
            "bindCode": bind_code.trim().to_uppercase(),
            "deviceName": device_name,
        }))
        .send()
    {
        Ok(response) if response.status().is_success() => {
            match response.json::<ActivationResponse>() {
                Ok(body) => body,
                Err(error) => {
                    log::warn!("[DevFleet] auto-bind skipped: activate response invalid: {error}");
                    return;
                }
            }
        }
        Ok(response) => {
            let error = response
                .json::<Value>()
                .ok()
                .and_then(|body| {
                    body.get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "activate failed".to_string());
            log::warn!("[DevFleet] auto-bind skipped: {error}");
            return;
        }
        Err(error) => {
            log::warn!("[DevFleet] auto-bind skipped: activate error: {error}");
            return;
        }
    };

    let detected_dev_tool = detect_preferred_dev_tool();
    for tool in scan_tools(None, None) {
        if tool.installed {
            log::info!(
                "[DevFleet] detected CLI: {} -> {}",
                tool.tool_name,
                tool.executable.as_deref().unwrap_or("?")
            );
        }
    }
    let config = AgentConfig {
        api_base_url: LOCAL_API_BASE.to_string(),
        device_token: activation.device_token,
        device_id: activation.device.id,
        device_name: {
            let name = activation.device.name.trim();
            if name.is_empty() {
                device_name.clone()
            } else {
                name.to_string()
            }
        },
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
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        dev_tool: detected_dev_tool.clone(),
        default_editor: detected_dev_tool,
        executor: "codex".to_string(),
    };

    if let Err(error) = state.save_config(&config) {
        log::warn!("[DevFleet] auto-bind failed to save config: {error}");
        return;
    }
    set_mutex(&state.inner.config, Some(config));
    state.start();
    log::info!(
        "[DevFleet] auto-bound localhost agent as {} (dev_tool={})",
        device_name,
        state
            .inner
            .config
            .lock()
            .ok()
            .and_then(|value| value.as_ref().map(|cfg| cfg.dev_tool.clone()))
            .unwrap_or_else(|| "trae".to_string())
    );
}

fn default_agent_workspace_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"C:\DevFleet\workspaces")
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .map(|home| PathBuf::from(home).join("DevFleet/workspaces"))
            .unwrap_or_else(|_| PathBuf::from("/tmp/DevFleet/workspaces"))
    }
}

fn local_device_name() -> String {
    StdCommand::new("hostname")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "DevFleet".to_string())
}

fn detect_preferred_dev_tool() -> String {
    let tools = scan_tools(None, None);
    for name in ["trae", "cursor", "codex", "claude_code"] {
        if tools
            .iter()
            .any(|tool| tool.tool_name == name && tool.installed)
        {
            return name.to_string();
        }
    }
    "trae".to_string()
}

fn set_mutex<T>(mutex: &Mutex<T>, value: T) {
    if let Ok(mut target) = mutex.lock() {
        *target = value;
    }
}

fn scan_tools(current_task: Option<&str>, active_dev_tool: Option<&str>) -> Vec<LocalToolStatus> {
    let processes = process_list();
    ["trae", "codex", "cursor", "claude_code"]
        .into_iter()
        .map(|name| {
            let executable = if name == "cursor" {
                resolve_cursor_agent()
                    .map(|(program, _)| program)
                    .or_else(|| find_executable("cursor"))
            } else if name == "trae" {
                resolve_trae_agent_cli()
                    .map(|inv| inv.program)
                    .or_else(|| find_executable("trae"))
                    .or_else(|| find_executable("trae-cli"))
            } else {
                find_executable(name)
            };
            let process_names: &[&str] = match name {
                "claude_code" => &["claude", "claude.exe"],
                "trae" => &["TRAE CN", "Trae CN", "TRAE SOLO CN", "trae", "trae.exe"],
                "cursor" => &["cursor", "cursor.exe", "agent"],
                _ => &["codex", "codex.exe"],
            };
            let running = process_names
                .iter()
                .any(|process| processes.contains(&process.to_lowercase()));
            let is_active = current_task.is_some() && active_dev_tool == Some(name);
            LocalToolStatus {
                tool_name: name.to_string(),
                status: if executable.is_none() {
                    "not_installed"
                } else if is_active {
                    "running"
                } else if running {
                    "running"
                } else {
                    "idle"
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

fn probe_capabilities() -> Value {
    let node_version = StdCommand::new("node")
        .arg("-v")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .filter(|version| !version.is_empty());

    let docker_output = StdCommand::new("docker").arg("--version").output().ok();
    let docker = docker_output
        .as_ref()
        .map(|output| output.status.success())
        .unwrap_or(false);
    let docker_version = docker_output
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .filter(|version| !version.is_empty());

    let (gpu, gpu_name) = detect_gpu();

    json!({
        "node_version": node_version,
        "docker": docker,
        "docker_version": docker_version,
        "gpu": gpu,
        "gpu_name": gpu_name,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

fn detect_gpu() -> (bool, Option<String>) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = StdCommand::new("system_profiler")
            .args(["SPDisplaysDataType"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            if !text.trim().is_empty() {
                let name = text
                    .lines()
                    .find(|line| line.contains("Chipset Model") || line.contains("Chip"))
                    .map(|line| line.split(':').nth(1).unwrap_or("").trim().to_string())
                    .filter(|name| !name.is_empty());
                return (true, name.or(Some("Apple GPU".to_string())));
            }
        }
        return (true, Some("Apple GPU".to_string()));
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(output) = StdCommand::new("nvidia-smi")
            .args(["--query-gpu=name", "--format=csv,noheader"])
            .output()
        {
            if output.status.success() {
                let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !name.is_empty() {
                    return (true, Some(name));
                }
            }
        }
    }

    (false, None)
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

fn user_local_bin_executable(binary: &str) -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())?;
    #[cfg(target_os = "windows")]
    let mut candidates = vec![PathBuf::from(&home).join(".local").join("bin").join(binary)];
    #[cfg(not(target_os = "windows"))]
    let candidates = vec![PathBuf::from(&home).join(".local").join("bin").join(binary)];
    #[cfg(target_os = "windows")]
    {
        candidates.push(
            PathBuf::from(&home)
                .join(".cursor")
                .join("bin")
                .join(format!("{binary}.exe")),
        );
        candidates.push(
            PathBuf::from(&home)
                .join(".cursor")
                .join("bin")
                .join(binary),
        );
    }
    first_existing_file(candidates)
}

fn first_existing_file(candidates: impl IntoIterator<Item = PathBuf>) -> Option<String> {
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

fn bundled_cursor_app_bin() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let path = PathBuf::from("/Applications/Cursor.app/Contents/Resources/app/bin");
        if path.is_dir() {
            return Some(path);
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let path = PathBuf::from(format!("{local}\\Programs\\cursor\\resources\\app\\bin"));
        if path.is_dir() {
            return Some(path);
        }
    }
    None
}

fn bundled_codex_cli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from(
        "/Applications/Codex.app/Contents/Resources/codex",
    ));
    #[cfg(target_os = "windows")]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        for rel in [
            r"Programs\Codex\resources\codex.exe",
            r"Programs\Codex\Codex.exe",
        ] {
            candidates.push(PathBuf::from(format!("{local}\\{rel}")));
        }
    }
    candidates
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
            "cursor" => vec![
                format!("{local}\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd"),
                format!("{local}\\Programs\\cursor\\Cursor.exe"),
            ],
            "codex" => bundled_codex_cli_candidates()
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            _ => vec![],
        };
        return candidates.into_iter().find(|path| Path::new(path).exists());
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(path) = user_local_bin_executable(binary) {
            return Some(path);
        }
        if let Ok(output) = StdCommand::new("which").arg(binary).output() {
            if output.status.success() {
                return Some(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
        }
        if tool == "codex" {
            if let Some(path) = first_existing_file(bundled_codex_cli_candidates()) {
                return Some(path);
            }
        }
        #[cfg(target_os = "macos")]
        {
            let candidates: Vec<PathBuf> = match tool {
                "trae" => {
                    if let Some(app) = computer_use::find_trae_app_bundle() {
                        if let Some(mac_os) =
                            app.join("Contents/MacOS")
                                .read_dir()
                                .ok()
                                .and_then(|entries| {
                                    entries
                                        .flatten()
                                        .find(|entry| entry.path().is_file())
                                        .map(|entry| entry.path())
                                })
                        {
                            return Some(mac_os.to_string_lossy().into_owned());
                        }
                    }
                    vec![
                        PathBuf::from("/Applications/Trae CN.app/Contents/MacOS/Trae CN"),
                        PathBuf::from("/Applications/TRAE SOLO CN.app/Contents/MacOS/TRAE SOLO CN"),
                        PathBuf::from("/Applications/Trae.app/Contents/MacOS/Trae"),
                        PathBuf::from("/Applications/TRAE SOLO.app/Contents/MacOS/TRAE SOLO"),
                    ]
                }
                "cursor" => {
                    let mut paths = Vec::new();
                    if let Some(bin_dir) = bundled_cursor_app_bin() {
                        paths.push(bin_dir.join("cursor"));
                    }
                    paths.push(PathBuf::from(
                        "/Applications/Cursor.app/Contents/MacOS/Cursor",
                    ));
                    paths
                }
                _ => vec![],
            };
            if let Some(path) = first_existing_file(candidates) {
                return Some(path);
            }
        }
        None
    }
}

fn launch_tool(tool: &str, workspace: &Path) -> Result<(), String> {
    launch_tool_for(tool, workspace)
}

fn launch_tool_for(tool: &str, workspace: &Path) -> Result<(), String> {
    let executable = if tool == "cursor" {
        find_executable("cursor")
    } else {
        find_executable(tool)
    }
    .ok_or_else(|| format!("未找到 {tool} 可执行文件"))?;
    StdCommand::new(executable)
        .arg(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn tool_is_available(tool: &str) -> bool {
    if tool == "cursor" {
        return find_executable("cursor").is_some() || resolve_cursor_agent().is_some();
    }
    find_executable(tool).is_some()
}

fn is_tool_process_running(tool: &str) -> bool {
    let processes = process_list();
    let process_names: &[&str] = match tool {
        "claude_code" => &["claude", "claude.exe"],
        "trae" => &["trae", "trae.exe", "trae cn", "trae solo cn", "trae solo"],
        "cursor" => &["cursor", "cursor.exe", "agent"],
        _ => &["codex", "codex.exe"],
    };
    process_names
        .iter()
        .any(|process| processes.contains(&process.to_lowercase()))
}

async fn checkout_work_branch(
    task_dir: &Path,
    work_branch: &str,
    base_branch: &str,
) -> Result<(), String> {
    if run_command(
        Some(task_dir),
        "git",
        &["show-ref", "--verify", &format!("refs/heads/{work_branch}")],
    )
    .await
    .is_ok()
    {
        run_command(Some(task_dir), "git", &["checkout", work_branch]).await?;
        return Ok(());
    }
    if !base_branch.is_empty()
        && run_command(
            Some(task_dir),
            "git",
            &["show-ref", "--verify", &format!("refs/heads/{base_branch}")],
        )
        .await
        .is_ok()
    {
        run_command(
            Some(task_dir),
            "git",
            &["checkout", "-b", work_branch, base_branch],
        )
        .await?;
        return Ok(());
    }
    run_command(Some(task_dir), "git", &["checkout", "-b", work_branch])
        .await
        .map(|_| ())?;
    Ok(())
}

async fn establish_trae_git_baseline(
    task_dir: &Path,
    tx: &TaskEventSink,
    task: &ExecuteTask,
) -> Result<(), String> {
    run_command(
        Some(task_dir),
        "git",
        &["config", "user.name", "DevFleet Agent"],
    )
    .await?;
    run_command(
        Some(task_dir),
        "git",
        &["config", "user.email", "agent@devfleet.local"],
    )
    .await?;
    run_command(Some(task_dir), "git", &["add", "-A"]).await?;
    let changes = run_command(Some(task_dir), "git", &["status", "--porcelain"]).await?;
    if changes.trim().is_empty() {
        return Ok(());
    }
    run_command(
        Some(task_dir),
        "git",
        &["commit", "-m", "chore(devfleet): task workspace setup"],
    )
    .await?;
    send_log(
        tx,
        task,
        "已建立 Trae 工作区 Git 基线（后续仅检测业务代码变更）",
        "info",
    );
    Ok(())
}

async fn git_has_meaningful_changes(task_dir: &Path) -> Result<bool, String> {
    let output = run_command(
        Some(task_dir),
        "git",
        &["status", "--porcelain", "--", ".", ":!.devfleet", ":!.trae"],
    )
    .await?;
    Ok(!output.trim().is_empty())
}

#[derive(Debug, PartialEq, Eq)]
enum GitCompletionMode {
    CommitPendingChanges,
    ReuseExistingCommit,
    NoChanges,
}

fn determine_git_completion_mode(
    baseline_head: Option<&str>,
    final_head: Option<&str>,
    status_output: &str,
) -> GitCompletionMode {
    if !status_output.trim().is_empty() {
        return GitCompletionMode::CommitPendingChanges;
    }
    if baseline_head != final_head {
        return GitCompletionMode::ReuseExistingCommit;
    }
    GitCompletionMode::NoChanges
}

async fn git_current_head(cwd: &Path) -> Result<Option<String>, String> {
    match run_command(Some(cwd), "git", &["rev-parse", "HEAD"]).await {
        Ok(output) => {
            let trimmed = output.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(error)
            if error.contains("ambiguous argument 'HEAD'")
                || error.contains("Needed a single revision")
                || error.contains("unknown revision or path not in the working tree") =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

async fn git_ref_exists(cwd: &Path, reference: &str) -> bool {
    run_command(
        Some(cwd),
        "git",
        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
    )
    .await
    .is_ok()
}

async fn resolve_merge_ref(cwd: &Path, branch_name: &str) -> Result<String, String> {
    let origin_ref = format!("origin/{branch_name}");
    if git_ref_exists(cwd, &origin_ref).await {
        return Ok(origin_ref);
    }
    let _ = run_command(
        Some(cwd),
        "git",
        &["fetch", "origin", &format!("{branch_name}:{branch_name}")],
    )
    .await;
    if git_ref_exists(cwd, &origin_ref).await {
        return Ok(origin_ref);
    }
    if git_ref_exists(cwd, branch_name).await {
        return Ok(branch_name.to_string());
    }
    Err(format!(
        "找不到可合并的分支 {branch_name}（已尝试 origin/{branch_name} 与本地 {branch_name}）"
    ))
}

async fn push_branch_if_remote(
    task_dir: &Path,
    branch: &str,
    tx: &TaskEventSink,
    task: &ExecuteTask,
) -> Result<(), String> {
    match run_command(Some(task_dir), "git", &["remote", "get-url", "origin"]).await {
        Ok(url) if !url.trim().is_empty() => {
            send_log(tx, task, "正在推送远程分支", "info");
            match run_command(Some(task_dir), "git", &["push", "-u", "origin", branch]).await {
                Ok(_) => {
                    send_log(tx, task, "远程分支已推送", "info");
                    Ok(())
                }
                Err(error) => {
                    let remote = url.trim();
                    if remote.starts_with("file://") {
                        run_command(
                            Some(task_dir),
                            "git",
                            &["push", "-u", remote, &format!("HEAD:{branch}")],
                        )
                        .await?;
                        send_log(tx, task, "已通过 file:// 远程推送分支", "info");
                        Ok(())
                    } else {
                        Err(error)
                    }
                }
            }
        }
        _ => {
            let repo_url = task.repo_url.trim();
            if repo_url.starts_with("file://") {
                send_log(tx, task, "正在推送到 file:// 远程仓库", "info");
                run_command(
                    Some(task_dir),
                    "git",
                    &["push", "-u", repo_url, &format!("HEAD:{branch}")],
                )
                .await?;
                send_log(tx, task, "远程分支已推送", "info");
                return Ok(());
            }
            send_log(
                tx,
                task,
                "未配置远程 origin，已完成本地提交（未 push）",
                "info",
            );
            Ok(())
        }
    }
}

/// Trae Agent CLI 调用方式（真正的 TRAE Agent CLI：`trae run "..."` / `trae-cli run "..."`）。
/// 注意：Trae IDE 自带的 `trae-cn` / `code` / `marscode` 只是 GUI 启动器，不是 Agent CLI。
#[derive(Clone, Debug)]
struct TraeCliInvocation {
    program: String,
    prefix: Vec<String>,
    subcommand: &'static str,
    label: &'static str,
}

fn bundled_trae_cli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(app) = computer_use::find_trae_app_bundle() {
        // 注意：trae-cn / marscode / code 是 Trae IDE 的 GUI 启动器，不是 Agent CLI。
        // 这里只探测真正的 TRAE Agent CLI 二进制（如果用户把它放进 .app 的 bin 目录）。
        for name in ["trae", "trae-cli"] {
            candidates.push(app.join("Contents/Resources/app/bin").join(name));
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        for rel in [
            r"Programs\Trae\resources\app\bin\trae.cmd",
            r"Programs\Trae\resources\app\bin\trae.exe",
            r"Programs\trae\resources\app\bin\trae.cmd",
        ] {
            candidates.push(PathBuf::from(format!("{local}\\{rel}")));
        }
    }
    candidates
}

fn resolve_trae_agent_cli() -> Option<TraeCliInvocation> {
    // TRAE Agent CLI 的全局选项（如 --config-file）通过 prefix 放在子命令前面。
    let mut prefix = Vec::new();
    if let Ok(config_file) = std::env::var("TRAE_CONFIG_FILE") {
        let config_file = config_file.trim().to_string();
        if !config_file.is_empty() {
            prefix.push("--config-file".to_string());
            prefix.push(config_file);
        }
    }

    if let Ok(from_env) = std::env::var("DEVFLEET_TRAE_CLI") {
        let program = from_env.trim().to_string();
        if !program.is_empty() {
            return Some(TraeCliInvocation {
                program,
                prefix,
                // 环境变量指定的 CLI 类型未知，默认 run（兼容 pip trae-cli）
                subcommand: "run",
                label: "DEVFLEET_TRAE_CLI",
            });
        }
    }

    // PATH 探测：只认真正的 TRAE Agent CLI。
    // Trae IDE 的启动器（trae-cn / marscode / code）只是打开 GUI 窗口，不是 Agent CLI。
    for (binary, subcommand, label) in [
        ("trae", "run", "trae run"),
        ("trae-cli", "run", "trae-cli run"),
    ] {
        if let Some(program) = find_binary_in_path(binary) {
            return Some(TraeCliInvocation {
                program,
                prefix: prefix.clone(),
                subcommand,
                label,
            });
        }
    }

    for candidate in bundled_trae_cli_candidates() {
        if candidate.is_file() {
            return Some(TraeCliInvocation {
                program: candidate.to_string_lossy().into_owned(),
                prefix: prefix.clone(),
                subcommand: "run",
                label: "Trae bundled CLI",
            });
        }
    }

    None
}

async fn run_trae_agent_cli(cwd: &Path, prompt: &str) -> Result<(String, String), String> {
    let invocation = resolve_trae_agent_cli().ok_or_else(|| {
        "未找到 TRAE Agent CLI。请安装 github.com/bytedance/trae-agent（命令：trae run 或 trae-cli run），或让 Trae IDE 设备走 Computer Use 兜底。".to_string()
    })?;
    let mut args: Vec<String> = invocation.prefix.clone();
    args.push(invocation.subcommand.to_string());
    args.push("--working-dir".to_string());
    args.push(cwd.to_string_lossy().into_owned());
    args.push(prompt.to_string());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_command(Some(cwd), &invocation.program, &arg_refs).await?;

    // TRAE Agent CLI 即使失败也可能返回退出码 0，必须通过输出内容二次判定。
    let trimmed = output.trim();
    if trimmed.contains("Success: ❌ No") || trimmed.contains("Error code:") {
        return Err(format!("TRAE Agent CLI 执行失败:\n{trimmed}"));
    }
    Ok((invocation.label.to_string(), output))
}

async fn execute_trae_computer_use_fallback(
    task_dir: &Path,
    trae_prompt: &str,
    tx: &TaskEventSink,
    task: &ExecuteTask,
) -> bool {
    send_log(
        tx,
        task,
        "[pipeline:computer_use] 回退：自动控制 Trae（打开工作区 → 信任 → 新任务 → 粘贴）…",
        "info",
    );

    let task_dir_for_cu = task_dir.to_path_buf();
    let trae_prompt_for_cu = trae_prompt.to_string();
    let keepalive_tx = tx.clone();
    let keepalive_task = task.clone();
    let keepalive = tokio::spawn(async move {
        let mut tick = 0u32;
        loop {
            tokio::time::sleep(Duration::from_secs(8)).await;
            tick += 1;
            send_log(
                &keepalive_tx,
                &keepalive_task,
                &format!("[pipeline:computer_use] 正在控制 Trae UI（第 {tick} 次心跳）…"),
                "info",
            );
        }
    });

    let cu_ok = match tokio::task::spawn_blocking(move || {
        computer_use::start_trae_task(&task_dir_for_cu, &trae_prompt_for_cu)
    })
    .await
    {
        Ok(Ok(())) => true,
        Ok(Err(first_error)) => {
            send_log(
                tx,
                task,
                &format!(
                    "[pipeline:computer_use] 首次自动控制失败，3.5s 后仅重试提交 prompt（不再新开窗口）: {first_error}"
                ),
                "warn",
            );
            tokio::time::sleep(Duration::from_millis(3500)).await;
            let task_dir_retry = task_dir.to_path_buf();
            let trae_prompt_retry = trae_prompt.to_string();
            match tokio::task::spawn_blocking(move || {
                computer_use::submit_trae_new_task(&task_dir_retry, &trae_prompt_retry)
            })
            .await
            {
                Ok(Ok(())) => true,
                Ok(Err(retry_error)) => {
                    send_log(
                        tx,
                        task,
                        &format!("[pipeline:computer_use] 自动控制失败: {retry_error}"),
                        "warn",
                    );
                    false
                }
                Err(join_error) => {
                    send_log(
                        tx,
                        task,
                        &format!("[pipeline:computer_use] 自动控制线程异常: {join_error}"),
                        "warn",
                    );
                    false
                }
            }
        }
        Err(join_error) => {
            send_log(
                tx,
                task,
                &format!("[pipeline:computer_use] 自动控制线程异常: {join_error}"),
                "warn",
            );
            false
        }
    };

    keepalive.abort();
    let _ = keepalive.await;

    if cu_ok {
        send_log(
            tx,
            task,
            "[pipeline:computer_use] 已自动打开 Trae、点击新任务并粘贴 prompt（无需用户手动复制）",
            "info",
        );
    } else {
        send_log(
            tx,
            task,
            "[pipeline:computer_use] 自动控制未成功，请确认辅助功能已授权 DevFleet/Trae，或在 Cursor 调用 devfleet_computer_use_submit_trae_task 补救（勿重复 open 以免多开窗口）",
            "warn",
        );
    }

    cu_ok
}

/// 解析 Cursor Agent CLI：优先独立 `agent` 二进制；macOS/Linux 可回退 `cursor agent`。
fn resolve_cursor_agent() -> Option<(String, Vec<String>)> {
    if let Ok(from_env) = std::env::var("DEVFLEET_CURSOR_AGENT") {
        let trimmed = from_env.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_file() {
            return Some((trimmed.to_string(), Vec::new()));
        }
    }
    if let Some(path) = find_binary_in_path("agent") {
        return Some((path, Vec::new()));
    }
    if let Some(path) = user_local_bin_executable("agent") {
        return Some((path, Vec::new()));
    }
    if let Some(bin_dir) = bundled_cursor_app_bin() {
        #[cfg(target_os = "windows")]
        for name in ["agent.cmd", "agent.exe"] {
            let candidate = bin_dir.join(name);
            if candidate.is_file() {
                return Some((candidate.to_string_lossy().into_owned(), Vec::new()));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let agent = bin_dir.join("agent");
            if agent.is_file() {
                return Some((agent.to_string_lossy().into_owned(), Vec::new()));
            }
            let cursor = bin_dir.join("cursor");
            if cursor.is_file() {
                return Some((
                    cursor.to_string_lossy().into_owned(),
                    vec!["agent".to_string()],
                ));
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    if let Some(path) = find_binary_in_path("cursor") {
        return Some((path, vec!["agent".to_string()]));
    }
    None
}

fn ai_agent_command_timeout() -> Duration {
    const DEFAULT_TIMEOUT_MS: u64 = 900_000;
    std::env::var("DEVFLEET_AI_AGENT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(DEFAULT_TIMEOUT_MS))
}

fn is_cursor_shadowed_binary(program: &str) -> bool {
    let exe = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_lowercase();
    if exe.contains("cursor") || exe == "agent" || exe == "agent.exe" || exe == "agent.cmd" {
        return true;
    }
    let lower = program.to_lowercase();
    if lower.contains("/cursor/") || lower.contains("\\cursor\\") {
        return true;
    }
    false
}

fn resolve_codex_cli() -> Result<String, String> {
    let env_override = std::env::var("DEVFLEET_CODEX_CLI")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|path| !path.is_empty());
    if let Some(program) = env_override {
        if !Path::new(&program).is_file() {
            return Err(format!("DEVFLEET_CODEX_CLI 指定路径无效：{program}"));
        }
        if is_cursor_shadowed_binary(&program) {
            return Err(
                "DEVFLEET_CODEX_CLI 指向 Cursor 相关可执行文件，不符合 Codex CLI 要求，请修正为真实的 codex 可执行文件".to_string(),
            );
        }
        return Ok(program);
    }

    let default_program = find_executable("codex").or_else(|| user_local_bin_executable("codex"));
    let Some(program) = default_program else {
        return Err("未找到 Codex CLI。目标设备需安装并登录 Codex（codex login）".to_string());
    };
    if is_cursor_shadowed_binary(&program) {
        return Err(
            format!(
                "未检测到明确的 Codex CLI（二进制 {program} 似乎是 Cursor/Agent 命令）。请执行 `where codex` 或 `which codex` 核对安装路径。"
            ),
        );
    }
    Ok(program)
}

fn command_timeout_ms_env(name: &str, default_ms: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_ms)
}

fn command_live_log_line_limit() -> u64 {
    std::env::var("DEVFLEET_COMMAND_LIVE_LOG_LINES")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(120)
}

fn command_timeouts(explicit: Option<Duration>) -> (Duration, Duration) {
    let soft_ms = explicit
        .map(|value| value.as_millis() as u64)
        .unwrap_or_else(|| command_timeout_ms_env("DEVFLEET_COMMAND_SOFT_TIMEOUT_MS", 900_000));

    let hard_ms = if let Some(explicit_ms) = explicit.map(|value| value.as_millis() as u64) {
        let hard_margin = command_timeout_ms_env("DEVFLEET_COMMAND_HARD_MARGIN_MS", 30_000);
        explicit_ms.saturating_add(hard_margin)
    } else {
        command_timeout_ms_env(
            "DEVFLEET_COMMAND_HARD_TIMEOUT_MS",
            soft_ms.saturating_add(30_000),
        )
    };

    (
        Duration::from_millis(soft_ms),
        Duration::from_millis((soft_ms.max(1)).max(hard_ms)),
    )
}

fn format_command(program: &str, args: &[&str]) -> String {
    let mut rendered = Vec::with_capacity(args.len() + 1);
    rendered.push(program.to_string());
    rendered.extend(args.iter().map(|arg| {
        let need_quote = arg.contains(' ') || arg.contains('"');
        if need_quote {
            format!("\"{}\"", arg.replace('"', "\\\""))
        } else {
            arg.to_string()
        }
    }));
    rendered.join(" ")
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

fn no_proxy_hosts_from_args(args: &[&str]) -> Vec<String> {
    let mut hosts = Vec::new();
    for raw in args {
        let token = raw.trim_matches(|ch: char| {
            ch == '"' || ch == '\'' || ch == '<' || ch == '>' || ch == '(' || ch == ')'
        });
        let host = if token.starts_with("git@") {
            token
                .strip_prefix("git@")
                .and_then(|value| value.split(':').next())
                .map(str::to_string)
        } else {
            Url::parse(token)
                .ok()
                .and_then(|url| url.host_str().map(str::to_string))
        };
        let Some(host) = host else {
            continue;
        };
        if is_lan_no_proxy_host(&host) && !hosts.iter().any(|item| item == &host) {
            hosts.push(host);
        }
    }
    hosts
}

fn append_no_proxy_env(command: &mut Command, hosts: &[String]) {
    let value = merge_no_proxy_entries(hosts.iter().map(String::as_str));
    command.env("NO_PROXY", &value).env("no_proxy", value);
}

async fn run_logged_command(
    task: &ExecuteTask,
    tx: &TaskEventSink,
    cwd: Option<&Path>,
    stage: &str,
    program: &str,
    args: &[&str],
    timeout: Option<Duration>,
) -> Result<String, String> {
    let command_line = format_command(program, args);
    send_log(
        tx,
        task,
        &format!("[pipeline:{stage}] 准备执行: {command_line}"),
        "info",
    );
    let started_at = std::time::Instant::now();
    let output = run_command_timed_observed(
        cwd,
        program,
        args,
        timeout,
        Some(CommandOutputObserver::new(
            task.clone(),
            tx.clone(),
            stage.to_string(),
        )),
    )
    .await;
    let elapsed = started_at.elapsed().as_secs_f64();

    match &output {
        Ok(stdout) => {
            send_log(
                tx,
                task,
                &format!("[pipeline:{stage}] 完成 ({}s)", format!("{elapsed:.1}")),
                "info",
            );
            if !stdout.trim().is_empty() {
                send_log(
                    tx,
                    task,
                    &format!(
                        "[pipeline:{stage}] 标准输出片段: {}",
                        truncate(&stdout, 1000)
                    ),
                    "info",
                );
            }
        }
        Err(error) => {
            send_log(
                tx,
                task,
                &format!(
                    "[pipeline:{stage}] 失败 ({}s): {error}",
                    format!("{elapsed:.1}")
                ),
                "error",
            );
        }
    }

    output
}

#[derive(Clone)]
struct CommandOutputObserver {
    task: ExecuteTask,
    tx: TaskEventSink,
    stage: String,
    remaining_lines: Arc<AtomicU64>,
    truncated_notified: Arc<AtomicBool>,
}

impl CommandOutputObserver {
    fn new(task: ExecuteTask, tx: TaskEventSink, stage: String) -> Self {
        Self {
            task,
            tx,
            stage,
            remaining_lines: Arc::new(AtomicU64::new(command_live_log_line_limit())),
            truncated_notified: Arc::new(AtomicBool::new(false)),
        }
    }

    fn emit(&self, stream: &str, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        let can_emit = self
            .remaining_lines
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_sub(1)
            })
            .is_ok();
        if can_emit {
            let label = if stream == "stderr" {
                "错误输出"
            } else {
                "输出"
            };
            send_log(
                &self.tx,
                &self.task,
                &format!(
                    "[pipeline:{}] {label}: {}",
                    self.stage,
                    truncate(trimmed, 1200)
                ),
                if stream == "stderr" { "warn" } else { "info" },
            );
            return;
        }
        if !self.truncated_notified.swap(true, Ordering::Relaxed) {
            send_log(
                &self.tx,
                &self.task,
                &format!(
                    "[pipeline:{}] 实时输出过多，后续输出仅保留在最终摘要中",
                    self.stage
                ),
                "warn",
            );
        }
    }
}

#[cfg(unix)]
fn kill_process_tree_unix(pid: u32, hard: bool) -> bool {
    let pid_s = pid.to_string();
    let signal = if hard { "KILL" } else { "TERM" };

    let _ = StdCommand::new("pkill")
        .arg(format!("-{signal}"))
        .arg("-P")
        .arg(&pid_s)
        .status();

    let _ = StdCommand::new("kill")
        .arg(format!("-{signal}"))
        .arg(&pid_s)
        .status();
    true
}

#[cfg(windows)]
fn kill_process_tree_windows(pid: u32, _hard: bool) -> bool {
    let pid_s = pid.to_string();
    let status = StdCommand::new("taskkill")
        .args(["/PID", &pid_s, "/T", "/F"])
        .status()
        .ok();
    status.is_some_and(|result| result.success())
}

fn kill_process_tree(pid: u32, hard: bool) -> bool {
    #[cfg(unix)]
    {
        return kill_process_tree_unix(pid, hard);
    }
    #[cfg(windows)]
    {
        return kill_process_tree_windows(pid, hard);
    }
}

async fn collect_stream_output(
    stream: ChildStdout,
    observer: Option<CommandOutputObserver>,
) -> String {
    collect_stream_output_lossy(stream, "stdout", observer).await
}

async fn collect_stream_output_err(
    stream: ChildStderr,
    observer: Option<CommandOutputObserver>,
) -> String {
    collect_stream_output_lossy(stream, "stderr", observer).await
}

async fn collect_stream_output_lossy<R>(
    mut stream: R,
    stream_name: &'static str,
    observer: Option<CommandOutputObserver>,
) -> String
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                let chunk = String::from_utf8_lossy(&buffer[..read]);
                if let Some(observer) = &observer {
                    observer.emit(stream_name, &chunk);
                }
                bytes.extend_from_slice(&buffer[..read]);
            }
            Err(error) => {
                let mut output = String::from_utf8_lossy(&bytes).into_owned();
                output.push_str(&format!("\n[devfleet:{stream_name}-read-error] {error}"));
                return output;
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

async fn run_cursor_agent(cwd: &Path, prompt: &str) -> Result<String, String> {
    let (program, prefix) = resolve_cursor_agent().ok_or_else(cursor_agent_missing_message)?;
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
    let output = run_command_timed(
        Some(cwd),
        &program,
        &arg_refs,
        Some(ai_agent_command_timeout()),
    )
    .await?;
    if looks_like_cursor_electron_stub(&output) {
        return Err(cursor_agent_missing_message());
    }
    Ok(output)
}

fn cursor_agent_missing_message() -> String {
    #[cfg(target_os = "windows")]
    {
        "未找到可用的 Cursor Agent CLI（独立 agent 命令）。Windows 不能用 cursor agent 子命令冒充。请在 Git Bash/WSL 执行: curl https://cursor.com/install -fsS | bash，然后 agent login 或设置 CURSOR_API_KEY；也可设置 DEVFLEET_CURSOR_AGENT 指向 agent.exe 的绝对路径。".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "未找到 Cursor Agent CLI。请安装：curl https://cursor.com/install -fsS | bash，并执行 agent login 或设置 CURSOR_API_KEY".to_string()
    }
}

fn looks_like_cursor_electron_stub(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("not in the list of known options")
        || lower.contains("warning: 'p' is not in the list")
}

async fn run_codex_agent(cwd: &Path, prompt: &str) -> Result<String, String> {
    let codex = resolve_codex_cli()?;
    run_command_timed(
        Some(cwd),
        &codex,
        &[
            "exec",
            "--sandbox",
            "workspace-write",
            "--ephemeral",
            prompt,
        ],
        Some(ai_agent_command_timeout()),
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
        if let Some(path) = user_local_bin_executable(binary) {
            return Some(path);
        }
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
    run_command_timed(cwd, program, args, None).await
}

async fn run_git_command(
    cwd: Option<&Path>,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    run_command_timed(cwd, "git", args, Some(timeout))
        .await
        .map_err(|error| {
            if error.contains("超时") {
                format!(
                    "{error}。请检查 Win 访问 GitHub 是否需代理，或在本机代理执行: git {}",
                    args.join(" ")
                )
            } else {
                error
            }
        })
}

async fn run_command_timed(
    cwd: Option<&Path>,
    program: &str,
    args: &[&str],
    timeout: Option<Duration>,
) -> Result<String, String> {
    run_command_timed_observed(cwd, program, args, timeout, None).await
}

async fn run_command_timed_observed(
    cwd: Option<&Path>,
    program: &str,
    args: &[&str],
    timeout: Option<Duration>,
    observer: Option<CommandOutputObserver>,
) -> Result<String, String> {
    let (soft_timeout, hard_timeout) = command_timeouts(timeout);
    let command_line = format_command(program, args);
    let mut command = Command::new(program);
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let no_proxy_hosts = no_proxy_hosts_from_args(args);
    append_no_proxy_env(&mut command, &no_proxy_hosts);

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 {program}: {error}"))?;
    let pid = child
        .id()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let command_pid = child.id().unwrap_or_default();
    if command_pid == 0 {
        let _ = child.kill().await;
        return Err(format!("执行 {command_line} 失败: 获取进程 ID 失败"));
    }

    let stdout_handle = child.stdout.take().map(|stream| {
        let observer = observer.clone();
        tokio::spawn(collect_stream_output(stream, observer))
    });
    let stderr_handle = child.stderr.take().map(|stream| {
        let observer = observer.clone();
        tokio::spawn(collect_stream_output_err(stream, observer))
    });

    let status = match time::timeout(soft_timeout, child.wait()).await {
        Ok(result) => result.map_err(|error| format!("执行 {command_line} 失败: {error}"))?,
        Err(_) => {
            let mut hard_timed_out = false;
            let hard_timed_out_first = hard_timeout > soft_timeout;
            let killed = kill_process_tree(command_pid, hard_timed_out_first);
            if hard_timeout > soft_timeout {
                let remaining = hard_timeout.saturating_sub(soft_timeout);
                match time::timeout(remaining, child.wait()).await {
                    Ok(Ok(_)) => {}
                    _ => {
                        hard_timed_out = true;
                        let _ = kill_process_tree(command_pid, true);
                    }
                }
            }
            let reason = if hard_timed_out {
                "硬超时"
            } else {
                "软超时"
            };
            let stdout = if let Some(handle) = stdout_handle {
                time::timeout(Duration::from_secs(2), handle)
                    .await
                    .ok()
                    .and_then(|result| result.ok())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            let stderr = if let Some(handle) = stderr_handle {
                time::timeout(Duration::from_secs(2), handle)
                    .await
                    .ok()
                    .and_then(|result| result.ok())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            return Err(format!(
                "{reason}终止进程 (pid={pid})：{command_line} (软超时 {}s / 硬超时 {}s，已尝试杀死={killed})\nstdout:{}\nstderr:{}",
                soft_timeout.as_secs(),
                hard_timeout.as_secs(),
                truncate(&stdout, 1000),
                truncate(&stderr, 1000),
            ));
        }
    };

    let stdout = if let Some(handle) = stdout_handle {
        handle.await.unwrap_or_default()
    } else {
        String::new()
    };
    let stderr = if let Some(handle) = stderr_handle {
        handle.await.unwrap_or_default()
    } else {
        String::new()
    };
    if status.success() {
        Ok(if stdout.trim().is_empty() {
            stderr
        } else {
            stdout
        })
    } else {
        let exit_code = status.code().unwrap_or(-1);
        Err(format!(
            "命令失败: {command_line} (exit {exit_code})\nargs={}\n{}",
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

    let _ = run_command(Some(cwd), "git", &["fetch", "--all", "--prune"]).await;
    run_command(Some(cwd), "git", &["checkout", &branch]).await?;
    let _ = run_command(Some(cwd), "git", &["pull", "--ff-only", "origin", &branch]).await;

    for branch_name in &subtask_branches {
        let merge_ref = resolve_merge_ref(cwd, branch_name).await?;
        match run_command(Some(cwd), "git", &["merge", "--no-edit", &merge_ref]).await {
            Ok(_) => {}
            Err(error) => {
                let status = run_command(Some(cwd), "git", &["status", "--porcelain"])
                    .await
                    .unwrap_or_else(|status_error| format!("无法读取冲突状态: {status_error}"));
                let conflicts = parse_git_conflict_files(&status);
                let _ = run_command(Some(cwd), "git", &["merge", "--abort"]).await;
                let conflict_text = if conflicts.is_empty() {
                    "未能解析冲突文件".to_string()
                } else {
                    conflicts.join(", ")
                };
                return Err(format!(
                    "合并 {merge_ref} 失败，已 abort。冲突文件: {conflict_text}\n{error}"
                ));
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

fn parse_git_conflict_files(status: &str) -> Vec<String> {
    status
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let code = &line[..2];
            if !(code.contains('U') || code == "AA" || code == "DD") {
                return None;
            }
            let path = line[3..].trim();
            if path.is_empty() {
                return None;
            }
            let final_path = path.rsplit(" -> ").next().unwrap_or(path).trim();
            Some(final_path.to_string())
        })
        .collect()
}

fn build_trae_project_mcp_json(api_base_url: &str, device_token: &str) -> String {
    let url = api_base_url.trim_end_matches('/');
    let mcp_path = find_executable("devfleet-mcp")
        .or_else(|| find_binary_in_path("node").map(|_| "node".to_string()))
        .unwrap_or_else(|| "node".to_string());
    let args = if mcp_path == "node" {
        vec!["dist-mcp/devfleet-mcp.mjs"]
    } else {
        vec![] as Vec<&str>
    };
    let config = json!({
        "mcpServers": {
            "devfleet": {
                "command": mcp_path,
                "args": args,
                "env": {
                    "DEVFLEET_API_URL": url,
                    "DEVFLEET_TOKEN": device_token,
                }
            }
        }
    });
    serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".to_string())
}

fn validate_task(task: &ExecuteTask) -> Result<(), String> {
    let repo_url = task.repo_url.trim();
    if !repo_url.is_empty()
        && !(repo_url.starts_with("https://")
            || repo_url.starts_with("http://")
            || repo_url.starts_with("git@")
            || repo_url.starts_with("git://")
            || repo_url.starts_with("file://"))
    {
        return Err(
            "仓库地址必须是 HTTP(S)、SSH、file:// Git 地址，或留空使用本地目录".to_string(),
        );
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

fn send_log(tx: &TaskEventSink, task: &ExecuteTask, content: &str, level: &str) {
    tx.send_or_queue(
        json!({
            "type": "task_log",
            "task_id": task.task_id,
            "subtask_id": task.subtask_id,
            "content": content,
            "level": level,
        }),
        PendingTaskReport {
            task_id: task.task_id.clone(),
            subtask_id: task.subtask_id.clone(),
            progress: None,
            status: None,
            content: content.to_string(),
            level: level.to_string(),
        },
    );
}

fn send_progress(tx: &TaskEventSink, task: &ExecuteTask, progress: u8, status: &str) {
    let content = format!("设备进度补报: {progress}% ({status})");
    tx.send_or_queue(
        json!({
            "type": "task_progress",
            "task_id": task.task_id,
            "subtask_id": task.subtask_id,
            "progress": progress,
            "status": status,
            "content": content,
        }),
        PendingTaskReport {
            task_id: task.task_id.clone(),
            subtask_id: task.subtask_id.clone(),
            progress: Some(progress),
            status: Some(status.to_string()),
            content,
            level: if status == "failed" { "error" } else { "info" }.to_string(),
        },
    );
}

fn normalize_remote_shell(shell: &str) -> String {
    match shell {
        "powershell" | "cmd" | "sh" | "bash" => shell.to_string(),
        _ if cfg!(target_os = "windows") => "powershell".to_string(),
        _ => "sh".to_string(),
    }
}

fn remote_shell_invocation(shell: &str, script: &str) -> (String, Vec<String>) {
    match shell {
        "powershell" => (
            if cfg!(target_os = "windows") {
                "powershell.exe".to_string()
            } else {
                "pwsh".to_string()
            },
            vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                script.to_string(),
            ],
        ),
        "cmd" => (
            if cfg!(target_os = "windows") {
                "cmd.exe".to_string()
            } else {
                "cmd".to_string()
            },
            vec!["/C".to_string(), script.to_string()],
        ),
        "bash" => (
            "bash".to_string(),
            vec!["-lc".to_string(), script.to_string()],
        ),
        _ => (
            "sh".to_string(),
            vec!["-lc".to_string(), script.to_string()],
        ),
    }
}

fn send_command_log(
    tx: &mpsc::UnboundedSender<Value>,
    command_id: &str,
    content: &str,
    level: &str,
) {
    let _ = tx.send(json!({
        "type": "command_log",
        "command_id": command_id,
        "content": content,
        "level": level,
    }));
}

fn send_command_result(
    tx: &mpsc::UnboundedSender<Value>,
    command: &ExecuteCommand,
    status: &str,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
    error: &str,
) {
    let _ = tx.send(json!({
        "type": "command_result",
        "command_id": command.command_id,
        "status": status,
        "exit_code": exit_code,
        "stdout": truncate(stdout, 200_000),
        "stderr": truncate(stderr, 200_000),
        "error": if error.is_empty() { Value::Null } else { json!(truncate(error, 4000)) },
    }));
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

    fn test_inner() -> Arc<AgentInner> {
        Arc::new(AgentInner {
            config_path: PathBuf::from("agent-test.json"),
            config: Mutex::new(None),
            connected: Mutex::new(false),
            tools: Mutex::new(Vec::new()),
            running_task: Mutex::new(None),
            running_dev_tool: Mutex::new(None),
            last_error: Mutex::new(None),
            pending_task_reports: Mutex::new(VecDeque::new()),
            generation: AtomicU64::new(0),
            loop_running: AtomicBool::new(false),
            paused: AtomicBool::new(false),
        })
    }

    #[test]
    fn trae_cli_resolution_from_env() {
        std::env::set_var("DEVFLEET_TRAE_CLI", "/tmp/devfleet-trae-cli");
        let resolved = resolve_trae_agent_cli();
        std::env::remove_var("DEVFLEET_TRAE_CLI");
        assert_eq!(
            resolved.as_ref().map(|inv| inv.program.as_str()),
            Some("/tmp/devfleet-trae-cli")
        );
    }

    #[test]
    fn accepts_git_repositories_and_safe_branches() {
        assert!(validate_task(&task("https://github.com/example/repo.git", "main")).is_ok());
        assert!(validate_task(&task("git@github.com:example/repo.git", "release/v1.0")).is_ok());
        assert!(validate_task(&task("file:///tmp/devfleet-e2e/bare.git", "main")).is_ok());
        assert!(validate_task(&task("", "main")).is_ok());
    }

    #[test]
    fn rejects_invalid_remote_urls_and_unsafe_branches() {
        assert!(validate_task(&task("C:\\secret", "main")).is_err());
        assert!(validate_task(&task("https://github.com/example/repo.git", "../../main")).is_err());
    }

    #[test]
    fn detects_cursor_electron_stub_output() {
        assert!(looks_like_cursor_electron_stub(
            "Warning: 'p' is not in the list of known options"
        ));
        assert!(!looks_like_cursor_electron_stub("done"));
    }

    #[test]
    fn task_lock_prevents_double_claim() {
        let slot = Mutex::new(None::<String>);

        let first_claim = {
            let mut guard = slot.lock().unwrap();
            if guard.is_some() {
                false
            } else {
                *guard = Some("task-a".to_string());
                true
            }
        };
        assert!(first_claim);

        let second_claim = {
            let guard = slot.lock().unwrap();
            guard.is_none()
        };
        assert!(!second_claim);

        {
            let mut guard = slot.lock().unwrap();
            if guard.as_deref() == Some("task-a") {
                *guard = None;
            }
        }

        let third_claim = {
            let mut guard = slot.lock().unwrap();
            if guard.is_some() {
                false
            } else {
                *guard = Some("task-b".to_string());
                true
            }
        };
        assert!(third_claim);
    }

    #[test]
    fn task_event_sink_queues_log_when_websocket_channel_is_closed() {
        let inner = test_inner();
        let (tx, rx) = mpsc::unbounded_channel::<Value>();
        drop(rx);
        let sink = TaskEventSink::new(tx, inner.clone());
        let task = task("https://example.com/repo.git", "main");

        send_log(&sink, &task, "Codex 已开始执行", "info");

        let queue = inner.pending_task_reports.lock().unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].task_id, "task-1");
        assert_eq!(queue[0].subtask_id, "sub-1");
        assert_eq!(queue[0].progress, None);
        assert_eq!(queue[0].status, None);
        assert_eq!(queue[0].content, "Codex 已开始执行");
        assert_eq!(queue[0].level, "info");
    }

    #[test]
    fn task_event_sink_queues_progress_when_websocket_channel_is_closed() {
        let inner = test_inner();
        let (tx, rx) = mpsc::unbounded_channel::<Value>();
        drop(rx);
        let sink = TaskEventSink::new(tx, inner.clone());
        let task = task("https://example.com/repo.git", "main");

        send_progress(&sink, &task, 40, "running");

        let queue = inner.pending_task_reports.lock().unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].progress, Some(40));
        assert_eq!(queue[0].status.as_deref(), Some("running"));
        assert!(queue[0].content.contains("40%"));
        assert_eq!(queue[0].level, "info");
    }

    #[test]
    fn command_output_observer_emits_realtime_task_log() {
        let inner = test_inner();
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        let sink = TaskEventSink::new(tx, inner);
        let observer = CommandOutputObserver::new(
            task("https://example.com/repo.git", "main"),
            sink,
            "codex".to_string(),
        );

        observer.emit("stdout", "live line\n");
        let payload = rx.try_recv().expect("stdout log payload");
        assert_eq!(payload["type"], "task_log");
        assert_eq!(payload["task_id"], "task-1");
        assert_eq!(payload["subtask_id"], "sub-1");
        assert_eq!(payload["level"], "info");
        assert!(payload["content"]
            .as_str()
            .unwrap()
            .contains("[pipeline:codex] 输出: live line"));

        observer.emit("stderr", "warning line\n");
        let payload = rx.try_recv().expect("stderr log payload");
        assert_eq!(payload["level"], "warn");
        assert!(payload["content"]
            .as_str()
            .unwrap()
            .contains("[pipeline:codex] 错误输出: warning line"));
    }

    #[test]
    fn parse_git_conflict_files_extracts_unmerged_paths() {
        let files = parse_git_conflict_files(
            "UU README.md\nAA src/app.ts\n M clean.txt\nR  old -> new.txt\n",
        );
        assert_eq!(
            files,
            vec!["README.md".to_string(), "src/app.ts".to_string()]
        );
    }

    #[test]
    fn git_completion_mode_detects_pending_changes() {
        assert_eq!(
            determine_git_completion_mode(Some("abc"), Some("abc"), " M README.md\n"),
            GitCompletionMode::CommitPendingChanges
        );
    }

    #[test]
    fn git_completion_mode_reuses_existing_commit_when_head_moves() {
        assert_eq!(
            determine_git_completion_mode(Some("abc"), Some("def"), ""),
            GitCompletionMode::ReuseExistingCommit
        );
    }

    #[test]
    fn git_completion_mode_reports_no_changes_when_clean_and_same_head() {
        assert_eq!(
            determine_git_completion_mode(Some("abc"), Some("abc"), ""),
            GitCompletionMode::NoChanges
        );
    }
}
