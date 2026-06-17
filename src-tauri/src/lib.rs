mod agent;
mod computer_use;
mod mcp;
mod network;
mod process_util;
mod server;

use std::net::TcpStream;
use std::time::Duration;

use tauri::{Manager, RunEvent};
use tauri::webview::WebviewWindowBuilder;
use tauri_utils::config::WebviewUrl;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(server::EmbeddedServer::default());
            if let Err(error) = server::cold_start_desktop_api(app.handle()) {
                log::error!("[DevFleet] {error}");
            }
            server::ensure_server_running(app.handle());

            let win = &app.config().app.windows[0];
            let min_width = win.min_width.unwrap_or(800.0);
            let min_height = win.min_height.unwrap_or(600.0);

            let url = resolve_webview_url(app);

            WebviewWindowBuilder::new(app, win.label.clone(), url)
                .title(win.title.clone())
                .inner_size(win.width, win.height)
                .min_inner_size(min_width, min_height)
                .center()
                .resizable(win.resizable)
                .fullscreen(win.fullscreen)
                .on_navigation(|url| network::allow_navigation(&url))
                .build()?;

            let agent_state = agent::AgentState::load(&app.handle());
            agent::start_saved_agent(&agent_state);
            let agent_for_autobind = agent_state.clone();
            let app_for_autobind = app.handle().clone();
            std::thread::spawn(move || {
                agent::try_auto_bind_localhost(&app_for_autobind, &agent_for_autobind);
            });
            app.manage(agent_state);

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = mcp::ensure_mcp_bundle(app_handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent::agent_bind,
            agent::agent_status,
            agent::agent_start,
            agent::agent_stop,
            agent::agent_unbind,
            agent::agent_open_tool,
            agent::agent_merge_task,
            mcp::mcp_client_statuses,
            mcp::install_mcp_client,
            mcp::install_trae_mcp,
            mcp::detect_trae_variant,
            mcp::ensure_mcp_bundle,
            network::get_lan_address,
            network::open_external_url,
            network::open_trae_install,
            server::restart_embedded_server_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                server::shutdown_embedded_server(app);
            }
        });
}

fn resolve_webview_url(app: &tauri::App) -> WebviewUrl {
    if cfg!(debug_assertions) {
        if let Some(dev_url) = app.config().build.dev_url.clone() {
            if dev_server_available(&dev_url) {
                return WebviewUrl::External(dev_url);
            }
            log::warn!(
                "[DevFleet] Vite dev server unavailable at {dev_url}, falling back to bundled frontend"
            );
        }
    }
    WebviewUrl::App("index.html".into())
}

fn dev_server_available(dev_url: &url::Url) -> bool {
    let host = dev_url.host_str().unwrap_or("127.0.0.1");
    let port = dev_url.port().unwrap_or(5173);
    let host = if host == "localhost" { "127.0.0.1" } else { host };
    let addr: std::net::SocketAddr = match format!("{host}:{port}").parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}
