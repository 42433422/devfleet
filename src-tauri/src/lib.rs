mod agent;
mod mcp;
mod network;
mod server;

use tauri::webview::WebviewWindowBuilder;
use tauri::Manager;
use tauri_utils::config::WebviewUrl;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(server::EmbeddedServer::default());
            server::ensure_server_running(app.handle());

            let win = &app.config().app.windows[0];
            let min_width = win.min_width.unwrap_or(800.0);
            let min_height = win.min_height.unwrap_or(600.0);

            let url = if cfg!(debug_assertions) {
                app.config()
                    .build
                    .dev_url
                    .clone()
                    .map(WebviewUrl::External)
                    .unwrap_or_else(|| WebviewUrl::App("index.html".into()))
            } else {
                WebviewUrl::App("index.html".into())
            };

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
            app.manage(agent_state);
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
            network::get_lan_address,
            network::open_external_url,
            network::open_trae_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
