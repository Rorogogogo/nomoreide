//! A thin way for the parity gate to call one host-provider operation.
//!
//! Nothing on the MCP surface reaches a host provider, and the daemon's
//! `/api/hosts/*` routes are Phase 8 work — so neither of the usual doors is
//! open. This example is what `scripts/check-host-parity.ts` drives instead:
//! one operation per run, arguments on the command line, and the result as JSON
//! on stdout — the same shape the TypeScript reference is asked for on the
//! other side.
//!
//! It is an example rather than a binary on purpose: nothing ships it, and it
//! cannot become a way to reach these operations from anywhere else.
use nomoreide_actions::vultr::VultrActions;
use nomoreide_core::config::ConfigStore;
use nomoreide_core::vultr_auth::resolve;
use nomoreide_core::vultr_context::{instance, list_instances, status};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut arguments = std::env::args().skip(1);
    let operation = arguments.next().unwrap_or_default();
    let rest: Vec<String> = arguments.collect();

    let store = ConfigStore::new(ConfigStore::default_path());
    let config = match store.load().await {
        Ok(config) => config,
        Err(error) => {
            println!(
                "{}",
                serde_json::json!({ "ok": false, "error": error.to_string() })
            );
            return;
        }
    };

    let report = match operation.as_str() {
        "status" => serde_json::json!({ "ok": true, "status": status(&store, &config).await }),
        "instances" => match list_instances(&store, &config).await {
            Ok(instances) => serde_json::json!({ "ok": true, "instances": instances }),
            Err(error) => serde_json::json!({ "ok": false, "error": error }),
        },
        "instance" => match instance(
            &store,
            &config,
            rest.first().map(String::as_str).unwrap_or_default(),
        )
        .await
        {
            Ok(found) => serde_json::json!({ "ok": true, "instance": found }),
            Err(error) => serde_json::json!({ "ok": false, "error": error }),
        },
        "action" => {
            let name = rest.first().cloned().unwrap_or_default();
            let target = rest.get(1).cloned().unwrap_or_default();
            match resolve(&store, &config) {
                Err(error) => serde_json::json!({ "ok": false, "error": error }),
                Ok(credential) => match VultrActions::new(credential.token)
                    .run(&name, &target)
                    .await
                {
                    Ok(()) => serde_json::json!({ "ok": true }),
                    Err(error) => serde_json::json!({ "ok": false, "error": error.message }),
                },
            }
        }
        other => {
            eprintln!("unknown operation {other}");
            std::process::exit(2);
        }
    };
    println!("{report}");
}
