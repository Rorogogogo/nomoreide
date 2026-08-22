//! The GitHub surface.
//!
//! Storing a token is a config write and needs no daemon, the same way
//! repository registration does.

use nomoreide_core::config::{ConfigStore, GithubCredentialSelection};

/// Store a personal access token for `host`, and point the selected repository
/// at it.
///
/// The second half is what makes the token take effect: a repository chooses
/// which account it pushes and comments as, and a token nothing has chosen is
/// only reachable by the legacy host lookup.
pub(super) async fn set_token(
    store: &ConfigStore,
    token: &str,
    host: &str,
) -> Result<String, String> {
    store
        .set_github_token(host.to_string(), token.to_string())
        .await
        .map_err(|error| error.to_string())?;
    let config = store.load().await.map_err(|error| error.to_string())?;
    if let Some(repository) = config.selected_git_repository.clone() {
        store
            .set_github_credential(
                &repository,
                GithubCredentialSelection::Stored {
                    host: host.to_string(),
                },
            )
            .await
            .map_err(|error| error.to_string())?;
    }
    // A sentence, not JSON: the reference reports this one as prose.
    Ok(format!("GitHub token stored for {host}."))
}
