use crate::core::one_time_skills::{
    resolve_one_time_skill, search_remote_skills, OneTimeSkillSelection, RemoteSkillResult,
};

#[tauri::command]
pub async fn search_skills(query: String) -> Result<Vec<RemoteSkillResult>, String> {
    search_remote_skills(&query).await
}

#[tauri::command]
pub async fn load_one_time_skill_prompt(skill: OneTimeSkillSelection) -> Result<String, String> {
    resolve_one_time_skill(&skill).await
}
