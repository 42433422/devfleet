mod agent;
mod network;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
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
            network::get_lan_address,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
