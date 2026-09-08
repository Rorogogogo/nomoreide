//! The Linear task surface: read the board, and move work across it.
//!
//! **Every call goes through the daemon**, like the terminal and incident
//! tools and unlike the git and config ones. The reason is where the state
//! lives: the Linear credential is in the daemon's connection store, an OAuth
//! grant is renewed on the way into a request, and the repository→team binding
//! is read from the same config the dashboard writes. An in-process client here
//! would need its own copy of all three and would drift from the panel the
//! moment either changed.
//!
//! **Moving is the one write, and it is deliberately narrow.** `move_issue`
//! sets a workflow state and nothing else — no assignee, no priority, no title,
//! no delete. An agent that can march a task across a board is useful; one that
//! can silently rewrite what the task *says* is a different and much larger
//! trust decision, and it is not made here.

use nomoreide_daemon_client::DaemonClient;
use serde_json::{json, Value};

/// How many issues a listing returns when the caller does not say.
///
/// Matches the page the dashboard asks for, so an agent and a person reading
/// the same board see the same first screen.
pub(crate) const DEFAULT_ISSUE_LIMIT: usize = 30;

async fn send(client: &DaemonClient, request: Value) -> Result<Value, String> {
    client
        .linear_request(&request)
        .await
        .map_err(|error| error.to_string())
}

/// The teams this workspace has, each with the states a board would column by
/// and the projects it can be filtered to.
///
/// This is what an agent reads *first*: moving an issue needs a state id, and
/// state ids are per-team and not guessable.
pub(crate) async fn teams(client: &DaemonClient) -> Result<String, String> {
    let data = send(client, json!({ "operation": "metadata" })).await?;
    let teams: Vec<Value> = data["teams"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .map(|team| {
                    json!({
                        "id": team["id"],
                        "key": team["key"],
                        "name": team["name"],
                        // Ordered the way a board reads, left to right, so a
                        // caller choosing "the next state" does not have to
                        // know Linear's enum.
                        "states": ordered_states(&team["states"]["nodes"]),
                        "projects": team["projects"]["nodes"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    crate::tools::render(&json!({
        "viewer": data["viewer"]["name"],
        // The team this repository is linked to, when one is. An agent working
        // in a checkout should file against that team rather than ask.
        "binding": data["binding"],
        "teams": teams,
    }))
}

/// Linear's fixed workflow-state enum, in the order work moves through it.
const STATE_ORDER: [&str; 6] = [
    "triage",
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
];

/// Sort a team's states into board order.
///
/// A state's `name` is the user's own text, so nothing keys off it; `type` is
/// Linear's enum and is what carries the meaning. An unrecognised type sorts
/// last rather than being dropped — a state Linear adds later should still
/// appear.
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

/// A team's issues, newest activity first.
pub(crate) async fn issues(
    client: &DaemonClient,
    team: &str,
    project: Option<&str>,
    limit: usize,
) -> Result<String, String> {
    let data = send(
        client,
        json!({ "operation": "issues", "team": team, "project": project }),
    )
    .await?;
    let nodes = data["issues"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let shown: Vec<Value> = nodes.iter().take(limit).map(summarise).collect();
    crate::tools::render(&json!({
        "issues": shown,
        // Said plainly rather than left to be inferred from a count: a caller
        // that asked for 5 of 30 should not conclude the team has 5.
        "returned": shown.len(),
        "hasMore": data["issues"]["pageInfo"]["hasNextPage"],
    }))
}

/// One issue, with its description and comments.
pub(crate) async fn issue(client: &DaemonClient, id: &str) -> Result<String, String> {
    let data = send(client, json!({ "operation": "issue", "id": id })).await?;
    let issue = &data["issue"];
    if issue.is_null() {
        return Err(format!("Linear has no issue {id}"));
    }
    let mut view = summarise(issue);
    view["description"] = issue["description"].clone();
    view["comments"] = json!(issue["comments"]["nodes"]
        .as_array()
        .map(|nodes| nodes
            .iter()
            .map(|comment| json!({ "author": comment["user"]["name"], "body": comment["body"] }))
            .collect::<Vec<_>>())
        .unwrap_or_default());
    crate::tools::render(&view)
}

/// Move an issue to a workflow state — the board drag, from an agent.
///
/// Answers with the issue as it stands *after* the move, read back rather than
/// assumed: Linear can refuse a transition, and a tool that reported the state
/// it asked for would make a refusal look like a success.
pub(crate) async fn move_issue(
    client: &DaemonClient,
    id: &str,
    state: &str,
) -> Result<String, String> {
    send(
        client,
        json!({ "operation": "update", "id": id, "state": state }),
    )
    .await?;
    let data = send(client, json!({ "operation": "issue", "id": id })).await?;
    crate::tools::render(&summarise(&data["issue"]))
}

/// Add a comment. The way an agent says what it did on the task it was given.
pub(crate) async fn comment(client: &DaemonClient, id: &str, body: &str) -> Result<String, String> {
    send(
        client,
        json!({ "operation": "comment", "id": id, "body": body }),
    )
    .await?;
    crate::tools::render(&json!({ "ok": true, "issue": id }))
}

/// The fields worth spending an agent's context on.
///
/// Deliberately not the whole issue: the raw shape carries ids for team,
/// project and assignee that a caller has no use for, and repeating the
/// description on every row of a thirty-issue listing would crowd out the
/// listing itself. `branchName` earns its place — it is what an agent needs to
/// start work.
fn summarise(issue: &Value) -> Value {
    json!({
        "id": issue["id"],
        "identifier": issue["identifier"],
        "title": issue["title"],
        "state": issue["state"]["name"],
        "stateId": issue["state"]["id"],
        "stateType": issue["state"]["type"],
        "priority": issue["priority"],
        "assignee": issue["assignee"]["name"],
        "branch": issue["branchName"],
        "url": issue["url"],
    })
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
            { "id": "2", "name": "In Progress", "type": "started" },
        ]);
        let ordered = ordered_states(&states);
        let names: Vec<&str> = ordered
            .iter()
            .map(|state| state["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Todo", "In Progress", "Done", "Parked"]);
    }

    /// The listing must not leak the ids a summary has no use for, and must
    /// keep the branch name, which is the one field an agent acts on.
    #[test]
    fn a_summary_keeps_the_branch_and_drops_the_nested_ids() {
        let view = summarise(&json!({
            "id": "abc", "identifier": "ROR-1", "title": "T", "url": "u",
            "branchName": "rob/ror-1-t", "priority": 2,
            "state": { "id": "s1", "name": "Todo", "type": "unstarted" },
            "assignee": { "id": "u1", "name": "Robert" },
            "team": { "id": "t1", "name": "Team" },
        }));
        assert_eq!(view["branch"], "rob/ror-1-t");
        assert_eq!(view["assignee"], "Robert");
        assert_eq!(view["state"], "Todo");
        assert!(view.get("team").is_none());
    }
}
