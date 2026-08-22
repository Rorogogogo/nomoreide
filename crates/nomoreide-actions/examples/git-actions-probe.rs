//! A thin way for the parity gate to call one write-capable git operation.
//!
//! `pull` and `pull_default` are reachable from the dashboard and the desktop
//! app but from no MCP tool, so the MCP gates cannot see them. This example is
//! what `scripts/check-git-actions-parity.ts` drives instead: one operation per
//! run, arguments on the command line, and the result as JSON on stdout — the
//! same shape the TypeScript reference is asked for on the other side.
//!
//! It is an example rather than a binary on purpose: nothing ships it, and it
//! cannot become a way to reach these operations from anywhere else.
use nomoreide_actions::git::GitActions;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut arguments = std::env::args().skip(1);
    let operation = arguments.next().unwrap_or_default();
    let cwd = arguments.next().unwrap_or_default();
    let rest: Vec<String> = arguments.collect();
    let actions = GitActions::new(cwd);

    let outcome = match operation.as_str() {
        "pull-default" => actions
            .pull_default(rest.first().map(String::as_str))
            .await
            .map(|result| serde_json::json!({ "branch": result.branch, "output": result.output })),
        "pull" => actions
            .pull()
            .await
            .map(|output| serde_json::json!({ "output": output })),
        other => {
            eprintln!("unknown operation {other}");
            std::process::exit(2);
        }
    };

    let report = match outcome {
        Ok(value) => serde_json::json!({ "status": "ok", "value": value }),
        Err(error) => serde_json::json!({ "status": "error", "message": error.to_string() }),
    };
    println!("{report}");
}
