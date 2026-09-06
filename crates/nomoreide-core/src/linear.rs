//! Fixed Linear GraphQL operations. Tokens stay in the host's connection store.
use crate::remote::protocol::linear::LinearRequest;
use serde_json::{json, Value};
use std::time::Duration;

const ISSUE: &str = "id identifier title description url branchName priority state { id name type } assignee { id name } team { id name } project { id name }";

pub async fn query(token: &str, query: &str, variables: Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create Linear client")?;
    let response = client
        .post("https://api.linear.app/graphql")
        .header("Authorization", token)
        .json(&json!({"query": query, "variables": variables}))
        .send()
        .await
        .map_err(|_| "Could not reach Linear")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "Linear rejected the connection. Check the API key and permissions.",
            429 => "Linear rate limit reached. Try again later.",
            _ => "Linear is unavailable. Try again later.",
        }
        .into());
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Invalid Linear response")?;
    decode(value)
}
fn decode(value: Value) -> Result<Value, String> {
    if value
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|e| !e.is_empty())
    {
        return Err(
            "Linear could not complete the request. Check access and the selected task or team."
                .into(),
        );
    }
    let data = value
        .get("data")
        .filter(|d| d.is_object())
        .ok_or("Linear returned no data")?;
    if data.as_object().is_some_and(|d| {
        d.values()
            .any(|v| v.get("success") == Some(&Value::Bool(false)))
    }) {
        return Err("Linear did not save the change".into());
    }
    Ok(data.clone())
}
pub async fn execute(token: &str, request: &LinearRequest) -> Result<Value, String> {
    request.validate()?;
    let (document, variables) = match request {
        LinearRequest::Binding { .. } => return Err("Binding must be handled by the host".into()),
        LinearRequest::Metadata {} => ("query { viewer { id name } teams(first: 100) { nodes { id name key states(first: 100) { nodes { id name type } } projects(first: 100) { nodes { id name } } } } }".into(), json!({})),
        LinearRequest::Issues { team, project, after } => {
            let mut filter = json!({"team": {"id": {"eq": team}}});
            if let Some(project) = project { filter["project"] = json!({"id": {"eq": project}}); }
            (format!("query($filter: IssueFilter!, $after: String) {{ issues(first: 30, after: $after, filter: $filter, orderBy: updatedAt) {{ nodes {{ {ISSUE} }} pageInfo {{ hasNextPage endCursor }} }} }}"), json!({"filter": filter, "after": after}))
        },
        LinearRequest::Issue { id } => (format!("query($id: String!) {{ issue(id: $id) {{ {ISSUE} comments(first: 50) {{ nodes {{ id body user {{ name }} }} pageInfo {{ hasNextPage endCursor }} }} }} }}"), json!({"id": id})),
        LinearRequest::Create { team, project, title, description } => (format!("mutation($input: IssueCreateInput!) {{ issueCreate(input: $input) {{ success issue {{ {ISSUE} }} }} }}"), json!({"input": {"teamId": team, "projectId": project, "title": title, "description": description}})),
        LinearRequest::Update { id, state } => (format!("mutation($id: String!, $input: IssueUpdateInput!) {{ issueUpdate(id: $id, input: $input) {{ success issue {{ {ISSUE} }} }} }}"), json!({"id": id, "input": {"stateId": state}})),
        LinearRequest::Comment { id, body } => ("mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body user { name } } } }".into(), json!({"input": {"issueId": id, "body": body}})),
    };
    query(token, &document, variables).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_partial_graphql_success_and_failed_mutations() {
        assert!(decode(json!({"data": {}, "errors": [{"message": "secret"}]})).is_err());
        assert!(decode(json!({"data": {"issueCreate": {"success": false}}})).is_err());
        assert!(decode(json!({"data": {"viewer": {"name": "A"}}})).is_ok());
    }
}
