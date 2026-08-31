//! A launch must never outlive the owner that started it.
//!
//! The window between forking a service and making its ownership record
//! durable is the one place a crash could leave a live process nobody knows
//! about. These tests kill a real owner process *inside* that window — at both
//! of its halves — and assert from the outside that the service never executed
//! and that whoever owns the runtime next is left with a clean journal.

#![cfg(unix)]

use nomoreide_core::log_store::LogStore;
use nomoreide_core::process_manager::ProcessManager;
use nomoreide_core::runtime_registry::RuntimeRegistry;
use serde_json::json;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use uuid::Uuid;

const ROOT_VARIABLE: &str = "NOMOREIDE_LAUNCH_CRASH_FIXTURE_ROOT";
const STAGE_VARIABLE: &str = "NOMOREIDE_UNSAFE_TEST_ABORT_AT_LAUNCH_STAGE";

/// The owner half: starts one service and is aborted mid-launch by the stage
/// hook. Inert unless the parent test hands it a fixture root.
#[test]
fn launch_crash_owner_fixture() {
    let Some(root) = std::env::var_os(ROOT_VARIABLE).map(PathBuf::from) else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async move {
        let manager = ProcessManager::with_runtime_registry(
            LogStore::new(root.join("logs")),
            RuntimeRegistry::new(registry_path(&root)),
        );
        let service = serde_json::from_value(json!({
            "name": "crash-launch",
            "command": "/bin/sh",
            "args": [
                "-c",
                format!(
                    "echo $$ > '{}'; exec sleep 300",
                    marker_path(&root).display()
                ),
            ],
            "cwd": root,
        }))
        .unwrap();
        let _ = manager.start_service(&service).await;
    });
    panic!("the owner should have aborted inside the launch window");
}

#[test]
fn owner_crash_before_journaling_leaves_no_service_and_no_record() {
    let root = fixture_root("before-journal");
    crash_owner_at(&root, "announced");

    assert!(!marker_path(&root).exists());
    assert!(!registry_path(&root).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn owner_crash_after_journaling_leaves_a_record_the_next_owner_reclaims() {
    let root = fixture_root("after-journal");
    crash_owner_at(&root, "journaled");

    // The service never executed, but the launch was already durable, so the
    // next owner has an exact identity to reclaim rather than a mystery.
    assert!(!marker_path(&root).exists());
    let records = recorded_pids(&registry_path(&root));
    assert_eq!(
        records.len(),
        1,
        "expected one journaled launch: {records:?}"
    );

    let reclaimed = ProcessManager::with_runtime_registry(
        LogStore::new(root.join("logs")),
        RuntimeRegistry::new(registry_path(&root)),
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        // The abandoned child is reparented and reaped asynchronously, so give
        // recovery a moment to observe a fully departed process group.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match reclaimed.reconcile_runtime().await {
                Ok(()) => break,
                Err(error) => {
                    assert!(Instant::now() < deadline, "recovery never settled: {error}");
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
        }
    });

    assert!(!process_group_exists(records[0]));
    assert!(recorded_pids(&registry_path(&root)).is_empty());
    let _ = std::fs::remove_dir_all(root);
}

/// Run an owner that aborts at `stage`, and hold the assertion that the service
/// it was launching never got to execute.
fn crash_owner_at(root: &Path, stage: &str) {
    std::fs::create_dir_all(root).unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "launch_crash_owner_fixture", "--nocapture"])
        .env(ROOT_VARIABLE, root)
        .env(STAGE_VARIABLE, stage)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();

    assert_eq!(
        status.signal(),
        Some(libc::SIGABRT),
        "the owner must die inside the launch window, not exit"
    );
    // A child parked before `exec` sees its owner's pipe close and leaves; the
    // marker only ever appears if the service actually ran.
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        assert!(
            !marker_path(root).exists(),
            "the service executed even though its owner crashed mid-launch"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn recorded_pids(path: &Path) -> Vec<u32> {
    let Ok(content) = std::fs::read(path) else {
        return Vec::new();
    };
    let document = serde_json::from_slice::<serde_json::Value>(&content).unwrap();
    document["records"]
        .as_object()
        .map(|records| {
            records
                .values()
                .map(|record| record["pid"].as_u64().unwrap() as u32)
                .collect()
        })
        .unwrap_or_default()
}

fn process_group_exists(pgid: u32) -> bool {
    let result = unsafe { libc::kill(-(pgid as libc::pid_t), 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn fixture_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("nomoreide-launch-crash-{label}-{}", Uuid::new_v4()))
}

fn registry_path(root: &Path) -> PathBuf {
    root.join("native").join("runtime-v1.json")
}

fn marker_path(root: &Path) -> PathBuf {
    root.join("executed.pid")
}
