//! Turning stored configuration into a usable Vultr client, and reporting what
//! the dashboard's status panel shows.
//!
//! The Rust half of `src/core/vultr-context.ts`.

use crate::config::{Config, ConfigStore};
use crate::providers::host::HostInstance;
use crate::vultr_auth::{cli_status, public_connection, resolve, VULTR_PROVIDER_ID};
use crate::vultr_manager::{VultrApiError, VultrManager};
use crate::vultr_provider::{instance_from_raw, manifest};
use serde_json::{json, Value};

/// A client, or the sentence explaining why there is not one.
pub fn require_client(store: &ConfigStore, config: &Config) -> Result<VultrManager, String> {
    resolve(store, config).map(|credential| VultrManager::new(credential.token))
}

/// The account, in the shape the dashboard reads.
pub fn account_from_raw(raw: &Value) -> Value {
    let email = raw.get("email").cloned().unwrap_or(Value::Null);
    let email_again = email.clone();
    json!({
        // Vultr issues no account id of its own, and the email is the only
        // stable handle it gives — so it is both the id and the display name.
        "id": email_again,
        "username": email,
        "name": raw.get("name").cloned().filter(|name| !name.is_null()).unwrap_or(Value::Null),
        "email": email,
    })
}

/// The credential-layer half of what the dashboard's status panel shows.
///
/// Deliberately *not* the whole panel: deciding between `auth_error` and
/// `connection_error`, and falling back to `{ source: "cli" }` for an ambient
/// credential, is assembly the daemon's `/api/hosts/:id/status` route does, and
/// that route is Phase 8. What lives here is what the provider itself knows.
pub async fn status(store: &ConfigStore, config: &Config) -> Value {
    let (cli_available, cli_error) = cli_status();
    let mut report = json!({
        "provider": manifest(),
        "cliAvailable": cli_available,
        "cliError": cli_error,
    });
    let object = report.as_object_mut().expect("status is an object");
    if let Some(connection) = public_connection(config) {
        object.insert("connection".into(), connection);
    }
    let account = match resolve(store, config) {
        Err(message) => json!({ "error": message }),
        Ok(credential) => match VultrManager::new(credential.token).account().await {
            Ok(raw) => account_from_raw(&raw),
            Err(error) => json!({ "error": error.message }),
        },
    };
    object.insert("account".into(), account);
    report
}

pub async fn list_instances(
    store: &ConfigStore,
    config: &Config,
) -> Result<Vec<HostInstance>, String> {
    let client = require_client(store, config)?;
    let raw = client.list_instances().await.map_err(error_text)?;
    Ok(raw.iter().map(instance_from_raw).collect())
}

pub async fn instance(
    store: &ConfigStore,
    config: &Config,
    id: &str,
) -> Result<HostInstance, String> {
    let client = require_client(store, config)?;
    let raw = client.instance(id).await.map_err(error_text)?;
    Ok(instance_from_raw(&raw))
}

fn error_text(error: VultrApiError) -> String {
    error.message
}

/// The provider id, so a caller does not have to name the string itself.
pub fn provider_id() -> &'static str {
    VULTR_PROVIDER_ID
}
