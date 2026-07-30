mod core;
mod commands;

use std::path::PathBuf;
use tauri::{Manager, RunEvent, State, WindowEvent};

use core::config::ConfigStore;
use core::log_store::LogStore;
use core::process_manager::ProcessManager;
use commands::terminal::TerminalManager;

// ---------------------------------------------------------------------------
// Shared application state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub config_store: ConfigStore,
    pub log_store: LogStore,
    pub process_manager: ProcessManager,
    pub terminal_manager: TerminalManager,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn run() {
    let config_path = ConfigStore::default_path();

    // Log dir: <project>/.nomoreide/logs — fall back to home if no project
    let log_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".nomoreide")
        .join("logs");

    let log_store = LogStore::new(log_dir);
    let process_manager = ProcessManager::new(log_store.clone());

    let state = AppState {
        config_store: ConfigStore::new(config_path),
        log_store,
        process_manager,
        terminal_manager: TerminalManager::new(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            // agent introspection
            commands::agent::get_agent_info,
            // agent chat
            commands::agent_chat::get_agent_chat_status,
            commands::agent_chat::start_agent_chat,
            commands::config::set_chat_provider,
            // onboard
            commands::onboard::scan_repo_url,
            commands::onboard::run_install_command,
            commands::onboard::clone_git_repository,
            // config
            commands::config::get_config,
            commands::config::register_service,
            commands::config::remove_service,
            commands::config::register_bundle,
            commands::config::register_git_repository,
            commands::config::remove_git_repository,
            commands::config::select_git_repository,
            commands::config::set_git_board_repositories,
            commands::config::register_database,
            commands::config::remove_database,
            commands::config::set_database_write_access,
            commands::config::set_github_token,
            commands::config::remove_github_token,
            commands::config::register_log_source,
            commands::config::remove_log_source,
            // system
            commands::system::open_external,
            // dashboard
            commands::dashboard::get_dashboard,
            // services
            commands::services::list_services,
            commands::services::service_processes,
            commands::services::start_service,
            commands::services::stop_service,
            commands::services::restart_service,
            commands::services::start_bundle,
            commands::services::stop_bundle,
            // git
            commands::git::git_status,
            commands::git::git_diff,
            commands::git::git_graph,
            commands::git::git_commit_diff,
            commands::git::git_commit_files,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_fetch,
            commands::git::git_create_branch,
            commands::git::git_switch_branch,
            commands::git::git_branches,
            commands::git::git_worktrees,
            commands::git::git_create_worktree,
            commands::git::git_select_worktree,
            commands::git::git_remove_worktree,
            commands::git::git_prune_worktrees,
            commands::git::git_pull_default,
            commands::git::git_list_files,
            commands::git::git_file_sizes,
            commands::git::git_read_file,
            commands::git::git_write_file,
            commands::git::get_github_repo,
            // logs
            commands::logs::get_logs,
            // terminal
            commands::terminal::list_terminal_sessions,
            commands::terminal::list_agent_transcripts,
            commands::terminal::create_terminal_session,
            commands::terminal::rename_terminal_session,
            commands::terminal::start_terminal_stream,
            commands::terminal::write_terminal_input,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal_session,
            // database
            commands::database::list_databases,
            commands::database::query_database,
            commands::database::execute_database,
            commands::database::list_tables,
            // github
            commands::github::get_github_token_status,
            commands::github::list_pull_requests,
            commands::github::get_pull_request,
            commands::github::create_pull_request,
            commands::github::get_pr_diff,
            commands::github::list_pr_files,
            commands::github::list_pr_reviews,
            commands::github::list_pr_comments,
            commands::github::merge_pull_request,
            commands::github::list_issues,
            commands::github::get_github_issue,
            commands::github::list_issue_comments,
            commands::github::add_issue_comment,
            commands::github::create_github_issue,
            commands::github::list_github_branches,
            commands::github::get_github_repo_info,
            commands::github::list_commit_check_runs,
            commands::github::list_workflow_runs,
            commands::github::list_workflow_run_jobs,
            commands::github::github_oauth_start,
            commands::github::github_oauth_poll,
            // snapshots
            commands::snapshots::create_snapshot,
            commands::snapshots::list_snapshots,
            commands::snapshots::restore_snapshot,
            commands::snapshots::delete_snapshot,
            commands::snapshots::get_snapshot_files,
            commands::snapshots::get_snapshot_diff,
            // workflows
            commands::workflows::list_workflows,
            commands::workflows::save_workflow,
            commands::workflows::delete_workflow,
        ])
        .on_window_event(|window, event| {
            // No tray icon, so a hidden window would be unrecoverable — quit the
            // app on close instead. RunEvent::Exit below still kills child procs.
            if let WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state: State<AppState> = app.state();
                let _ = state.terminal_manager.close_all();
                state.process_manager.kill_all();
            }
        });
}
