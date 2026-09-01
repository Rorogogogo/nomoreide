mod commands;
mod event_sink;

pub fn run_terminal_attach(socket_path: &str, token: &str) -> Result<(), String> {
    nomoreide_core::external_terminal::run_attach(socket_path, token)
}

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, State, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::net::TcpListener;
use tokio::sync::{watch, Mutex};

use nomoreide_core::config::ConfigStore;
use nomoreide_core::log_store::LogStore;
use nomoreide_core::process_manager::ProcessManager;
use nomoreide_core::terminal::TerminalManager;

// ---------------------------------------------------------------------------
// Shared application state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub config_store: ConfigStore,
    pub log_store: LogStore,
    pub process_manager: ProcessManager,
    pub terminal_manager: TerminalManager,
    pub database_exports: Mutex<HashMap<String, Option<watch::Sender<bool>>>>,
    daemon_task: StdMutex<Option<tauri::async_runtime::JoinHandle<anyhow::Result<()>>>>,
}

const DAEMON_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const DAEMON_STARTUP_POLL: Duration = Duration::from_millis(50);

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
        database_exports: Mutex::new(HashMap::new()),
        daemon_task: StdMutex::new(None),
    };

    let mut context = tauri::generate_context!();
    let main_window = context
        .config()
        .app
        .windows
        .first()
        .cloned()
        .expect("the Tauri config must define the main window");
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let runtime_paths = nomoreide_daemon_client::RuntimePaths::new(
                app.path().app_local_data_dir()?.join("runtime"),
            );
            let window_config = main_window.clone();
            tauri::async_runtime::spawn(async move {
                match start_embedded_daemon(runtime_paths).await {
                    Ok(daemon_task) => {
                        let state: State<AppState> = app_handle.state();
                        state
                            .daemon_task
                            .lock()
                            .expect("embedded daemon task mutex poisoned")
                            .replace(daemon_task);

                        let window_app = app_handle.clone();
                        let error_app = app_handle.clone();
                        if let Err(error) = app_handle.run_on_main_thread(move || {
                            if let Err(error) =
                                WebviewWindowBuilder::from_config(&window_app, &window_config)
                                    .and_then(WebviewWindowBuilder::build)
                            {
                                show_startup_error(&window_app, &error.to_string());
                            }
                        }) {
                            show_startup_error(&error_app, &error.to_string());
                        }
                    }
                    Err(error) => show_startup_error(&app_handle, &error),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // agent introspection
            commands::agent::get_agent_info,
            // agent chat
            commands::agent_chat::get_agent_chat_status,
            commands::agent_chat::start_agent_chat,
            commands::config::set_chat_provider,
            // context library
            commands::context::list_context,
            commands::context::get_context_graph,
            commands::context::get_context_note,
            commands::context::create_context_note,
            commands::context::update_context_note,
            commands::context::delete_context_note,
            commands::context::set_context_pins,
            commands::context::preview_context,
            // onboard
            commands::onboard::scan_repo_url,
            commands::onboard::run_install_command,
            commands::onboard::clone_git_repository,
            // config
            commands::config::get_config,
            commands::config::get_service_definition,
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
            commands::git::git_identity_state,
            commands::git::git_push,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_merge,
            commands::git::git_rebase,
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
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
            commands::git::git_search_files,
            commands::git::git_search_content,
            commands::git::git_read_file,
            commands::git::git_write_file,
            commands::git::get_github_repo,
            // logs
            commands::logs::get_logs,
            // remote skills
            commands::skills::search_skills,
            commands::skills::load_one_time_skill_prompt,
            // terminal
            commands::terminal::list_terminal_sessions,
            commands::terminal::list_agent_transcripts,
            commands::terminal::create_terminal_session,
            commands::terminal::rename_terminal_session,
            commands::terminal::start_terminal_stream,
            commands::terminal::write_terminal_input,
            commands::terminal::resize_terminal,
            commands::terminal::get_terminal_capabilities,
            commands::terminal::open_terminal_in_system_terminal,
            commands::terminal::reclaim_terminal_to_dock,
            commands::terminal::insert_agent_prompt,
            commands::terminal::close_terminal_session,
            // database
            commands::database::list_databases,
            commands::database::query_database,
            commands::database::execute_database,
            commands::database::list_tables,
            commands::database::test_database_connection,
            commands::database::database_capabilities,
            commands::database::list_database_schemas,
            commands::database::list_database_objects,
            commands::database::get_database_object_details,
            commands::database::sample_database_object,
            commands::database::export_database_object,
            commands::database::cancel_database_export,
            commands::database::delete_database_rows,
            // github
            commands::github::get_github_token_status,
            commands::github::list_github_accounts,
            commands::github::set_github_account,
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
            // all-projects overview
            commands::overview::project_overview,
            // vercel
            commands::vercel::vercel_status,
            commands::vercel::vercel_connect,
            commands::vercel::vercel_disconnect,
            commands::vercel::vercel_set_scope,
            commands::vercel::vercel_oauth_start,
            commands::vercel::vercel_oauth_phase,
            commands::vercel::vercel_list_projects,
            commands::vercel::vercel_set_project,
            commands::vercel::vercel_get_project,
            commands::vercel::vercel_list_env,
            commands::vercel::vercel_env_value,
            commands::vercel::vercel_list_domains,
            commands::vercel::vercel_list_deployments,
            commands::vercel::vercel_get_deployment,
            commands::vercel::vercel_deployment_logs,
            commands::vercel::vercel_runtime_logs,
            commands::vercel::vercel_deployment_action,
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
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let state: State<AppState> = window.state();
                if state.terminal_manager.has_external_presentations() {
                    let _ = window.hide();
                } else {
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let state: State<AppState> = app.state();
                        if let Err(error) = state.terminal_manager.close_all() {
                            eprintln!("NoMoreIDE refused to exit: {error}");
                            return;
                        }
                        match state.process_manager.shutdown_all().await {
                            Ok(()) => app.exit(0),
                            Err(error) => eprintln!("NoMoreIDE refused to exit: {error}"),
                        }
                    });
                }
            }
        })
        .build(context)
        .expect("error building tauri application")
        .run(|app, event| match event {
            RunEvent::Exit => {
                let state: State<AppState> = app.state();
                if let Some(daemon_task) = state
                    .daemon_task
                    .lock()
                    .expect("embedded daemon task mutex poisoned")
                    .take()
                {
                    daemon_task.abort();
                }
                let _ = state.terminal_manager.close_all();
                state.process_manager.kill_all();
            }
            RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}

async fn start_embedded_daemon(
    runtime_paths: nomoreide_daemon_client::RuntimePaths,
) -> Result<tauri::async_runtime::JoinHandle<anyhow::Result<()>>, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("failed to reserve a private daemon port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to inspect the private daemon port: {error}"))?
        .port();
    let options = nomoreide_daemon::DaemonOptions {
        port,
        runtime_paths,
        config_path: ConfigStore::default_path(),
    };
    let mut daemon_task = tauri::async_runtime::spawn(async move {
        nomoreide_daemon::run_with_listener(options, listener).await
    });

    let health_url = format!("http://127.0.0.1:{port}/api/health");
    let http = reqwest::Client::builder()
        .timeout(Duration::from_millis(250))
        .build()
        .map_err(|error| format!("failed to create the daemon health client: {error}"))?;
    let deadline = Instant::now() + DAEMON_STARTUP_TIMEOUT;
    loop {
        tokio::select! {
            result = &mut daemon_task => {
                return Err(match result {
                    Ok(Ok(())) => "the embedded daemon stopped during startup".to_string(),
                    Ok(Err(error)) => format!("the embedded daemon failed during startup: {error:#}"),
                    Err(error) => format!("the embedded daemon task failed during startup: {error}"),
                });
            }
            response = http.get(&health_url).send() => {
                if response.is_ok_and(|response| response.status().is_success()) {
                    return Ok(daemon_task);
                }
            }
        }

        if Instant::now() >= deadline {
            daemon_task.abort();
            return Err(format!(
                "the embedded daemon did not become ready within {} seconds",
                DAEMON_STARTUP_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(DAEMON_STARTUP_POLL).await;
    }
}

fn show_startup_error(app: &tauri::AppHandle, error: &str) {
    let exit_app = app.clone();
    app.dialog()
        .message(format!(
            "NoMoreIDE could not start its local service.\n\n{error}"
        ))
        .title("NoMoreIDE startup failed")
        .kind(MessageDialogKind::Error)
        .show(move |_| exit_app.exit(1));
}
