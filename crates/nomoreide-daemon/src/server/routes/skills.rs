//! Temporary skills: search for one, and turn one into a prompt.
//!
//! Both routes are exact, so a wrong method falls through to the SPA shell's
//! 404 rather than answering 405.
//!
//! **The body schema is enforced here rather than in core**, because it is a
//! description of what this endpoint accepts rather than of what a skill is:
//! exactly one key at each level, both strings, trimmed before their lengths
//! are judged, and no unknown keys at all. Everything it refuses gets one
//! message, because telling a caller *which* field was wrong tells an attacker
//! the same thing.
//!
//! The two refusals are different refusals and keep different statuses. A body
//! this schema rejects is a 400 that never reaches the source validator; a body
//! it accepts whose source is invalid is a 422 from the validator, which is
//! what stands between a client-supplied string and a subprocess.

use crate::server::app::AppState;
use crate::server::errors::error;
use crate::server::routes::query::query_value;
use axum::body::Bytes;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_core::one_time_skills::{
    resolve_one_time_skill, search_remote_skills_detailed, OneTimeSkillSelection,
};
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/skills/search", get(search))
        .route("/api/skills/use", post(use_skill))
}

/// A rejected query is the caller's fault; a timeout is the upstream's; and
/// anything else skills.sh did is reported as a bad gateway rather than as a
/// failure of this daemon.
async fn search(uri: Uri) -> Response {
    let query = query_value(&uri, "q").unwrap_or_default();
    match search_remote_skills_detailed(&query).await {
        Ok(skills) => Json(json!({ "ok": true, "skills": skills })).into_response(),
        Err(failure) => {
            let status = match failure.code {
                "invalid_query" => StatusCode::BAD_REQUEST,
                "timeout" => StatusCode::GATEWAY_TIMEOUT,
                _ => StatusCode::BAD_GATEWAY,
            };
            (
                status,
                Json(json!({ "ok": false, "error": failure.message, "code": failure.code })),
            )
                .into_response()
        }
    }
}

async fn use_skill(body: Bytes) -> Response {
    let Some(selection) = parse_selection(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid temporary skill request.");
    };
    match resolve_one_time_skill(&selection).await {
        Ok(prompt) => Json(json!({ "ok": true, "prompt": prompt })).into_response(),
        Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
    }
}

/// `{ "skill": { "name": ..., "source": ... } }`, and nothing else at either
/// level. Lengths are measured in UTF-16 code units, on the trimmed value,
/// because that is what the reference's schema measures.
fn parse_selection(body: &Bytes) -> Option<OneTimeSkillSelection> {
    let document: Value = serde_json::from_slice(body).ok()?;
    let outer = document.as_object()?;
    if outer.len() != 1 {
        return None;
    }
    let skill = outer.get("skill")?.as_object()?;
    if skill.len() != 2 {
        return None;
    }
    let name = skill.get("name")?.as_str()?.trim().to_string();
    let source = skill.get("source")?.as_str()?.trim().to_string();
    let units = |value: &str| value.encode_utf16().count();
    if !(1..=200).contains(&units(&name)) || !(3..=400).contains(&units(&source)) {
        return None;
    }
    Some(OneTimeSkillSelection { name, source })
}
