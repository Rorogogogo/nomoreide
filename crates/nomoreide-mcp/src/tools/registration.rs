//! Registering a service or a bundle.
//!
//! These two tools write config rather than touching the runtime, so they run
//! entirely locally; the daemon re-reads the file per operation and picks up
//! what they wrote without being told.
//!
//! Arguments pass two gates, and the split is the reference's. The first, in
//! `protocol/contracts.rs`, asks whether each field is well-formed on its own.
//! The second, here, asks whether the fields together describe a service of
//! some kind — a compose service needs a `composeService`, an ssh service needs
//! a `host`, and a local one needs a `command` and a `cwd`. A caller can
//! satisfy every field individually and still describe nothing runnable, which
//! is why the second gate exists at all, and why its refusal is shaped like the
//! validator's own report rather than a sentence: it has to say which of the
//! three readings it tried and what each one was missing.

use super::render;
use nomoreide_core::config::{BundleDef, ConfigStore};
use nomoreide_core::service_definition::{service_definition, string, strings};
use serde_json::{Map, Value};

pub(super) async fn register_service(
    store: &ConfigStore,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let definition = service_definition(arguments)?;
    let config = store
        .register_service(definition)
        .await
        .map_err(|error| error.to_string())?;
    let view = config.public_view();
    render(&view)
}

pub(super) async fn register_bundle(
    store: &ConfigStore,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let bundle = BundleDef {
        name: string(arguments, "name").unwrap_or_default().to_string(),
        services: strings(arguments, "services"),
    };
    let config = store
        .register_bundle(bundle, None)
        .await
        .map_err(|error| error.to_string())?;
    let view = config.public_view();
    render(&view)
}
