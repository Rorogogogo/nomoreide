//! `nomoreide linear <subcommand>` — read the board and move work across it.
//!
//! **Through the daemon**, like `logs` and `start` and unlike `git`. The Linear
//! credential lives in the daemon's connection store, an OAuth grant is renewed
//! on the way into a request, and the repository→team binding is read from the
//! same config the dashboard writes. A second Linear client here would need its
//! own copy of all three.
//!
//! **`move` is the only write**, and it moves a workflow state and nothing
//! else. Marching a task across a board is a useful thing to hand a terminal;
//! rewriting what the task says is a different decision and is not on this
//! surface. `comment` is the exception that proves it — it appends, and appending
//! cannot destroy what was already there.

use nomoreide_daemon_client::DaemonClient;
use serde_json::{json, Value};

use crate::commands::{CliError, CliResult};
use crate::flags::{parse_flags, positional_args};

const USAGE: &str = "Usage: nomoreide linear [teams|issues|show|move|comment]";

pub async fn run(subcommand: Option<&str>, args: &[String], client: &DaemonClient) -> CliResult {
    let flags = parse_flags(args);
    let positional = positional_args(args);
    let first = positional.first().map(String::as_str);

    match subcommand {
        Some("teams") => teams(client).await,
        Some("issues") => {
            // The team may be named or left to the repository's binding, so a
            // checkout that has been linked needs no argument at all.
            let team = match flags.nullish("team") {
                Some(team) => team.to_string(),
                None => bound_team(client).await?,
            };
            issues(client, &team, flags.nullish("project")).await
        }
        Some("show") => show(client, require(first, "an issue")?).await,
        Some("move") => {
            let id = require(first, "an issue")?;
            let state = require(positional.get(1).map(String::as_str), "a target state")?;
            move_issue(client, id, state).await
        }
        Some("comment") => {
            let id = require(first, "an issue")?;
            let body = require(positional.get(1).map(String::as_str), "a comment body")?;
            comment(client, id, body).await
        }
        _ => Err(CliError::usage(USAGE)),
    }
}

fn require<'a>(value: Option<&'a str>, what: &str) -> Result<&'a str, CliError> {
    value
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::usage(format!("{USAGE}\n\nThis needs {what}.")))
}

async fn send(client: &DaemonClient, request: Value) -> Result<Value, CliError> {
    client
        .linear_request(&request)
        .await
        .map_err(|error| CliError::failure(error.to_string()))
}

/// The team this repository is linked to, or a sentence saying to name one.
async fn bound_team(client: &DaemonClient) -> Result<String, CliError> {
    let data = send(client, json!({ "operation": "metadata" })).await?;
    data["binding"]["team"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| {
            CliError::failure(
                "This repository is not linked to a Linear team. Pass --team, or link it in the dashboard.",
            )
        })
}

async fn teams(client: &DaemonClient) -> CliResult {
    let data = send(client, json!({ "operation": "metadata" })).await?;
    for team in data["teams"]["nodes"].as_array().unwrap_or(&Vec::new()) {
        println!(
            "{}  {}  {}",
            team["key"].as_str().unwrap_or("--"),
            team["id"].as_str().unwrap_or_default(),
            team["name"].as_str().unwrap_or_default()
        );
        // The states are printed under their team because a state id is only
        // meaningful within one — `move` needs the id, and this is where a
        // person reads it off.
        for state in ordered_states(&team["states"]["nodes"]) {
            println!(
                "    {:<10} {}  {}",
                state["type"].as_str().unwrap_or_default(),
                state["id"].as_str().unwrap_or_default(),
                state["name"].as_str().unwrap_or_default()
            );
        }
    }
    Ok(())
}

const STATE_ORDER: [&str; 6] = [
    "triage",
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
];

/// Board order: the path work takes, left to right. An unknown type sorts last
/// rather than disappearing.
fn ordered_states(states: &Value) -> Vec<Value> {
    let mut nodes: Vec<Value> = states.as_array().cloned().unwrap_or_default();
    nodes.sort_by_key(|state| {
        let kind = state["type"].as_str().unwrap_or_default().to_string();
        let rank = STATE_ORDER
            .iter()
            .position(|known| *known == kind)
            .unwrap_or(STATE_ORDER.len());
        (rank, state["name"].as_str().unwrap_or_default().to_string())
    });
    nodes
}

async fn issues(client: &DaemonClient, team: &str, project: Option<&str>) -> CliResult {
    let data = send(
        client,
        json!({ "operation": "issues", "team": team, "project": project }),
    )
    .await?;
    for issue in data["issues"]["nodes"].as_array().unwrap_or(&Vec::new()) {
        println!(
            "{:<10} {:<14} {}",
            issue["identifier"].as_str().unwrap_or_default(),
            issue["state"]["name"].as_str().unwrap_or_default(),
            issue["title"].as_str().unwrap_or_default()
        );
    }
    if data["issues"]["pageInfo"]["hasNextPage"] == Value::Bool(true) {
        println!("\n(more in Linear)");
    }
    Ok(())
}

async fn show(client: &DaemonClient, id: &str) -> CliResult {
    let data = send(client, json!({ "operation": "issue", "id": id })).await?;
    let issue = &data["issue"];
    if issue.is_null() {
        return Err(CliError::failure(format!("Linear has no issue {id}")));
    }
    println!(
        "{} {}",
        issue["identifier"].as_str().unwrap_or_default(),
        issue["title"].as_str().unwrap_or_default()
    );
    println!(
        "state   {}",
        issue["state"]["name"].as_str().unwrap_or_default()
    );
    println!(
        "branch  {}",
        issue["branchName"].as_str().unwrap_or_default()
    );
    println!("url     {}", issue["url"].as_str().unwrap_or_default());
    if let Some(description) = issue["description"]
        .as_str()
        .filter(|text| !text.is_empty())
    {
        println!("\n{description}");
    }
    for comment in issue["comments"]["nodes"].as_array().unwrap_or(&Vec::new()) {
        println!(
            "\n--- {}\n{}",
            comment["user"]["name"].as_str().unwrap_or("someone"),
            comment["body"].as_str().unwrap_or_default()
        );
    }
    Ok(())
}

/// Move an issue, then read it back.
///
/// Read back rather than assumed: Linear can refuse a transition, and printing
/// the state that was *asked for* would make a refusal look like a success.
async fn move_issue(client: &DaemonClient, id: &str, state: &str) -> CliResult {
    send(
        client,
        json!({ "operation": "update", "id": id, "state": state }),
    )
    .await?;
    let data = send(client, json!({ "operation": "issue", "id": id })).await?;
    println!(
        "{} is now {}",
        data["issue"]["identifier"].as_str().unwrap_or(id),
        data["issue"]["state"]["name"].as_str().unwrap_or_default()
    );
    Ok(())
}

async fn comment(client: &DaemonClient, id: &str, body: &str) -> CliResult {
    send(
        client,
        json!({ "operation": "comment", "id": id, "body": body }),
    )
    .await?;
    println!("Commented on {id}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_sort_into_board_order_and_keep_unknown_ones() {
        let states = json!([
            { "id": "4", "name": "Done", "type": "completed" },
            { "id": "1", "name": "Todo", "type": "unstarted" },
            { "id": "9", "name": "Parked", "type": "invented-later" },
            { "id": "2", "name": "Doing", "type": "started" },
        ]);
        let names: Vec<String> = ordered_states(&states)
            .iter()
            .map(|state| state["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(names, ["Todo", "Doing", "Done", "Parked"]);
    }

    #[test]
    fn a_missing_argument_is_a_usage_error_naming_what_is_missing() {
        let failure = require(None, "an issue").unwrap_err();
        let text = failure.message_text().unwrap_or_default();
        assert!(text.contains("an issue"), "{text}");
    }
}
