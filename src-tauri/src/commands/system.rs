//! Misc OS-integration commands that don't belong to a feature domain.

/// Open a URL (or file path) in the OS default handler — the browser for
/// `http(s)://` links. The Tauri WebView swallows `window.open`, so the
/// frontend routes external links through here to reach the real browser.
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let spawn = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let spawn = std::process::Command::new("xdg-open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let spawn = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();

    spawn
        .map(|_| ())
        .map_err(|e| format!("Failed to open {url}: {e}"))
}
