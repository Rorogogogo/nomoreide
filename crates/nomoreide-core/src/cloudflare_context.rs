//! Resolves "which Cloudflare account does this token mean" — the Rust
//! counterpart of `src/core/cloudflare-context.ts`.

use serde_json::Value;

use crate::cloudflare_actions::CloudflareActions;
use crate::cloudflare_auth::{resolve, ResolvedCredential, CLOUDFLARE_PROVIDER_ID};
use crate::cloudflare_manager::CloudflareManager;
use crate::config::{Config, ConfigStore};

/// A connected Cloudflare client and the credential behind it.
pub async fn require_client(
    store: &ConfigStore,
    config: &Config,
) -> Result<(CloudflareManager, ResolvedCredential), String> {
    let credential = resolve(store, config).await?;
    let account_id = match credential.account_id.clone() {
        Some(account_id) => Some(account_id),
        None => adopt_sole_account(store, &credential).await,
    };
    let manager = CloudflareManager::new(credential.token.clone(), account_id.clone());
    Ok((
        manager,
        ResolvedCredential {
            account_id,
            ..credential
        },
    ))
}

/// Write-capable counterpart, resolved the same way but returned separately so
/// the read/write split is visible at the call site.
///
/// Unlike the read client, this one *requires* an account: every Pages write is
/// a `PATCH` of `/accounts/<id>/…`, and there is no useful thing to do without
/// one.
pub async fn require_actions(
    store: &ConfigStore,
    config: &Config,
) -> Result<CloudflareActions, String> {
    let credential = resolve(store, config).await?;
    let account_id = match credential.account_id.clone() {
        Some(account_id) => account_id,
        None => adopt_sole_account(store, &credential)
            .await
            .ok_or("Choose a Cloudflare account before changing one of its projects.")?,
    };
    Ok(CloudflareActions::new(credential.token, account_id))
}

/// The account to use when the user has never chosen one.
///
/// Every Pages path is `/accounts/<id>/…`, so a client without one can do
/// nothing at all — which is why the sole account is adopted rather than left
/// for the scope switcher to ask about. With several there is no unambiguous
/// answer, so none is chosen.
///
/// **A `cli` credential adopts but does not persist.** Wrangler has no account
/// switch of its own; the account comes from `CLOUDFLARE_ACCOUNT_ID` in the
/// environment, and a saved scope would outrank that variable from then on.
///
/// Failures are swallowed: an unscoped client still reports the "choose an
/// account" message, and the caller's own request should be what surfaces an
/// auth problem.
async fn adopt_sole_account(
    store: &ConfigStore,
    credential: &ResolvedCredential,
) -> Option<String> {
    let accounts = CloudflareManager::new(credential.token.clone(), None)
        .list_accounts()
        .await
        .ok()?;
    if accounts.len() != 1 {
        return None;
    }
    let account = accounts.first()?;
    let id = account.get("id").and_then(Value::as_str)?.to_string();
    if credential.source != "cli" {
        let name = account
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string);
        store
            .set_connection_scope(CLOUDFLARE_PROVIDER_ID, Some(id.clone()), name)
            .await
            .ok()?;
    }
    Some(id)
}
