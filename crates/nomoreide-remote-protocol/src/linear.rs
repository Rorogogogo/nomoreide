//! Linear operations shared by local and remote clients. Credentials never enter this protocol.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum LinearRequest {
    Metadata {},
    Binding {
        team: String,
        project: Option<String>,
    },
    Issues {
        team: String,
        project: Option<String>,
        after: Option<String>,
    },
    Issue {
        id: String,
    },
    Create {
        team: String,
        project: Option<String>,
        title: String,
        description: String,
    },
    Update {
        id: String,
        state: String,
    },
    Comment {
        id: String,
        body: String,
    },
}
impl LinearRequest {
    pub fn is_mutating(&self) -> bool {
        matches!(
            self,
            Self::Binding { .. } | Self::Create { .. } | Self::Update { .. } | Self::Comment { .. }
        )
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        fn id(value: &str) -> bool {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        }
        let valid = match self {
            Self::Metadata {} => true,
            Self::Binding { team, project } => id(team) && project.as_deref().map_or(true, id),
            Self::Issues {
                team,
                project,
                after,
            } => {
                id(team)
                    && project.as_deref().map_or(true, id)
                    && after.as_ref().map_or(true, |s| s.len() <= 512)
            }
            Self::Issue { id: value } => id(value),
            Self::Create {
                team,
                project,
                title,
                description,
            } => {
                id(team)
                    && project.as_deref().map_or(true, id)
                    && !title.trim().is_empty()
                    && title.len() <= 512
                    && description.len() <= 16000
            }
            Self::Update { id: value, state } => id(value) && id(state),
            Self::Comment { id: value, body } => {
                id(value) && !body.trim().is_empty() && body.len() <= 16000
            }
        };
        if valid {
            Ok(())
        } else {
            Err("Invalid Linear request or field length")
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LinearResponse {
    pub data: LinearData,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn writes_and_input_boundaries() {
        assert!(!(LinearRequest::Metadata {}).is_mutating());
        let write = LinearRequest::Comment {
            id: "ENG-1".into(),
            body: "Hello".into(),
        };
        assert!(write.is_mutating());
        assert!(write.validate().is_ok());
        assert!(LinearRequest::Issue {
            id: "../token".into()
        }
        .validate()
        .is_err());
        assert!(serde_json::from_value::<LinearRequest>(
            serde_json::json!({"operation":"metadata", "token":"secret"})
        )
        .is_err());
    }
}

/// Only these provider fields may leave the host. Unknown response fields are dropped.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinearData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teams: Option<Connection<Team>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewer: Option<Choice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<Binding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issues: Option<Connection<Issue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<Issue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_create: Option<IssueMutation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_update: Option<IssueMutation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_create: Option<CommentMutation>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Choice {
    pub id: String,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Binding {
    pub team: String,
    pub project: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection<T> {
    pub nodes: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_info: Option<PageInfo>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub has_next_page: bool,
    pub end_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Team {
    pub id: String,
    pub name: String,
    pub states: Connection<Choice>,
    pub projects: Connection<Choice>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub url: String,
    pub branch_name: String,
    pub priority: u8,
    pub state: Choice,
    pub team: Choice,
    pub assignee: Option<Choice>,
    pub project: Option<Choice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comments: Option<Connection<Comment>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Comment {
    pub id: String,
    pub body: String,
    pub user: Option<CommentUser>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommentUser {
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IssueMutation {
    pub success: bool,
    pub issue: Option<Issue>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommentMutation {
    pub success: bool,
    pub comment: Option<Comment>,
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use crate::{version::capabilities, DeviceBound};
    #[test]
    fn wire_policy_separates_reads_from_writes() {
        let read = DeviceBound::Linear(LinearRequest::Metadata {});
        assert!(!read.mutating());
        assert_eq!(read.required_capability(), Some(capabilities::LINEAR));
        for request in [
            LinearRequest::Binding {
                team: "team".into(),
                project: None,
            },
            LinearRequest::Create {
                team: "team".into(),
                project: None,
                title: "Task".into(),
                description: String::new(),
            },
            LinearRequest::Update {
                id: "ENG-1".into(),
                state: "done".into(),
            },
            LinearRequest::Comment {
                id: "ENG-1".into(),
                body: "Comment".into(),
            },
        ] {
            assert!(DeviceBound::Linear(request).mutating());
        }
    }
    #[test]
    fn remote_response_drops_credentials_and_unexpected_fields() {
        let response: LinearData = serde_json::from_value(serde_json::json!({
            "token": "secret", "hostPath": "/private/repository",
            "viewer": {"id":"user", "name":"Name", "email":"private@example.com", "token":"secret"},
            "teams": {"nodes": []}
        }))
        .unwrap();
        let encoded = serde_json::to_string(&response).unwrap();
        assert!(!encoded.contains("secret"));
        assert!(!encoded.contains("private"));
        assert!(encoded.contains("Name"));
    }
}
