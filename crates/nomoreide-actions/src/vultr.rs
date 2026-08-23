//! Vultr's power operations — the write half of the host provider.
//!
//! The Rust half of `src/core/vultr-actions.ts`. These live here rather than in
//! `nomoreide-core` for the same reason `git.rs` and `db.rs` do: reads inspect,
//! writes reach out and change something a human is responsible for.
//!
//! Note what this does *not* claim, per this crate's own module docs: living
//! here is not what keeps an agent out. `nomoreide-mcp` depends on this crate
//! already, for `nomoreide_git_push`. What keeps halt and reboot away from an
//! agent is the MCP tool surface — the frozen manifest has no host tool at all,
//! and `npm run mcp:parity -- --surface-only` fails if one appears.

use nomoreide_core::vultr_manager::{request, VultrApiError};
use nomoreide_core::vultr_provider::VULTR_ACTIONS;

pub struct VultrActions {
    token: String,
}

impl VultrActions {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
        }
    }

    /// Run one named power operation against one instance.
    ///
    /// The name is checked against the manifest's list rather than matched into
    /// a path, so a caller cannot reach an endpoint the manifest never
    /// advertised by naming it.
    pub async fn run(&self, action: &str, instance: &str) -> Result<(), VultrApiError> {
        if !VULTR_ACTIONS.contains(&action) {
            return Err(VultrApiError {
                message: format!("Vultr does not support the action \"{action}\"."),
                status: 404,
            });
        }
        let path = format!(
            "/instances/{}/{}",
            urlencoding::encode(instance),
            urlencoding::encode(action)
        );
        request(&self.token, &path, reqwest::Method::POST).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_action_the_manifest_never_advertised_is_refused_before_any_request() {
        let error = VultrActions::new("unused")
            .run("destroy", "inst_1")
            .await
            .unwrap_err();
        assert_eq!(
            error.message,
            "Vultr does not support the action \"destroy\"."
        );
        assert_eq!(error.status, 404);
    }
}
