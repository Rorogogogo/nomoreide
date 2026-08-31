//! Write-capable Vultr power operations, deliberately separate from the
//! read-safe `vultr_manager` — the same split as `git_manager` / git write
//! commands, `db::peek` / `nomoreide_actions::db`, and `cloudflare_manager` /
//! `cloudflare_actions`. The Rust half of `src/core/vultr-actions.ts`.
//!
//! Everything here interrupts a machine someone may be depending on, so none of
//! it is exposed to an agent: these are reached only from the dashboard's own
//! routes, where a human clicked the button.
//!
//! Deliberately excludes the irreversible ones. Vultr's
//! `DELETE /instances/{id}` destroys the machine and its disk, and
//! `POST /instances/{id}/reinstall` wipes it — neither belongs behind the same
//! button as "reboot", and neither is implemented here at all.

use crate::vultr_manager::{request, VultrApiError};
// The action names live beside the manifest that declares them, not here: what
// a provider offers is a manifest fact, and this module's job is to perform one
// rather than to define the list. "halt" rather than "stop" is Vultr's own
// word, which is the whole reason the neutral surface takes a *name* instead of
// fixing methods into the contract.
use crate::vultr_provider::VULTR_ACTIONS;

pub struct VultrActions {
    token: String,
}

impl VultrActions {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
        }
    }

    /// Power a stopped instance back on.
    pub async fn start(&self, instance_id: &str) -> Result<(), VultrApiError> {
        self.power(instance_id, "start").await
    }

    /// Power an instance off.
    ///
    /// Vultr's "halt" is a hard power-off, not a graceful shutdown — the guest
    /// OS is not asked first. That is why it counts as production-affecting.
    pub async fn halt(&self, instance_id: &str) -> Result<(), VultrApiError> {
        self.power(instance_id, "halt").await
    }

    /// Hard-restart an instance.
    pub async fn reboot(&self, instance_id: &str) -> Result<(), VultrApiError> {
        self.power(instance_id, "reboot").await
    }

    /// Perform a named action.
    ///
    /// The name is checked against [`VULTR_ACTIONS`] before it becomes a path,
    /// so an unknown one is a refusal rather than a `POST` to an endpoint that
    /// does not exist — the route checks the manifest first, and this is the
    /// second door on the same rule.
    pub async fn run(&self, action: &str, instance_id: &str) -> Result<(), VultrApiError> {
        if !VULTR_ACTIONS.contains(&action) {
            return Err(VultrApiError {
                message: format!("Vultr does not support the action \"{action}\"."),
                status: 0,
            });
        }
        self.power(instance_id, action).await
    }

    /// The three power endpoints are identical apart from their last path
    /// segment, and all three answer 204 with no body.
    async fn power(&self, instance_id: &str, action: &str) -> Result<(), VultrApiError> {
        let path = format!("/instances/{}/{action}", urlencoding::encode(instance_id));
        request(&self.token, &path, reqwest::Method::POST).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The names that would become a `POST` to an endpoint Vultr does not
    /// serve — or worse, to one it does. `destroy` and `reinstall` are real
    /// Vultr endpoints this module deliberately does not implement, so a route
    /// that let one through would be a request away from an unrecoverable
    /// machine.
    #[tokio::test]
    async fn an_undeclared_action_never_becomes_a_request() {
        let actions = VultrActions::new("token");
        for action in ["destroy", "reinstall", "delete", "stop", "", "START"] {
            let refusal = actions.run(action, "inst").await.unwrap_err();
            assert!(refusal.message.contains(action), "{action}");
            // Status 0 is this module's own refusal, not a vendor's.
            assert_eq!(refusal.status, 0, "{action}");
        }
    }
}
