//! Where an agent's skills are installed.
//!
//! A skill is a *directory*, and that directory's name is the skill's name —
//! not whatever `SKILL.md` names itself, and not conditional on a `SKILL.md`
//! being there at all. Anything in a skills directory is reported, so a
//! half-installed skill shows up as one rather than vanishing.

use super::{Agent, SkillEntry};
use std::path::{Path, PathBuf};

/// User-scope skills first, then project-scope, each sorted by name.
pub(super) fn discover(agent: Agent, home: &Path, cwd: &Path) -> Vec<SkillEntry> {
    // Plugins first, in their record's own order — the reference lists what was
    // installed as a unit ahead of what was dropped into a directory.
    let mut skills = super::plugins::discover(agent, home);
    for relative in agent.user_skills_relative_paths() {
        skills.extend(entries_in(&home.join(relative), "user"));
    }
    if let Some(relative) = agent.project_skills_relative_path() {
        if let Some(directory) = nearest_ancestor_holding(cwd, relative) {
            skills.extend(entries_in(&directory, "project"));
        }
    }
    skills
}

/// The closest directory at or above `start` that holds `relative`.
///
/// This walks up on its own terms rather than asking where the repository root
/// is: a skills directory above a project is still that project's, and a
/// directory that is not a repository at all still has skills above it.
fn nearest_ancestor_holding(start: &Path, relative: &str) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(directory) = current {
        let candidate = directory.join(relative);
        if candidate.is_dir() {
            return Some(candidate);
        }
        current = directory.parent();
    }
    None
}

fn entries_in(directory: &Path, scope: &'static str) -> Vec<SkillEntry> {
    let Ok(listing) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut entries: Vec<SkillEntry> = listing
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| SkillEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            source: Some("local".to_string()),
            kind: "skill",
            scope,
            install_path: Some(entry.path().to_string_lossy().into_owned()),
            plugin_skills: None,
            plugin_mcps: None,
            plugin_agents: None,
            plugin_commands: None,
        })
        .collect();
    // `read_dir` order is whatever the filesystem happens to hand back, which
    // differs between machines and even between runs; the listing is sorted so
    // that two readings of the same directory agree.
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nomoreide-skills-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::remove_dir_all(&path).ok();
        path
    }

    #[test]
    fn a_directory_is_a_skill_whether_or_not_it_describes_itself() {
        let home = scratch("named");
        let skills = home.join(".claude/skills");
        std::fs::create_dir_all(skills.join("zulu")).unwrap();
        std::fs::create_dir_all(skills.join("alpha")).unwrap();
        std::fs::create_dir_all(skills.join("nameless")).unwrap();
        std::fs::write(
            skills.join("alpha/SKILL.md"),
            "---\nname: something-else\n---\n",
        )
        .unwrap();
        std::fs::write(skills.join("loose-file.md"), "not a skill").unwrap();

        // Asked about a directory outside any project, so only user scope
        // can answer.
        let found = discover(Agent::Claude, &home, Path::new("/"));
        std::fs::remove_dir_all(&home).ok();

        // Sorted by directory name, and `alpha` keeps its directory's name
        // rather than the one its own front matter claims.
        assert_eq!(
            found
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "nameless", "zulu"]
        );
        assert!(found.iter().all(|skill| skill.scope == "user"));
    }

    #[test]
    fn a_home_directory_is_its_own_project_when_asked_from_inside_it() {
        // Nothing stops the walk upwards at a repository boundary, so asking
        // about a directory under `~` finds `~/.claude/skills` a second time —
        // once as the user's, once as the project's. Both are reported.
        let home = scratch("home-as-project");
        std::fs::create_dir_all(home.join(".claude/skills/summarise")).unwrap();
        std::fs::create_dir_all(home.join("deep")).unwrap();
        let found = discover(Agent::Claude, &home, &home.join("deep"));
        std::fs::remove_dir_all(&home).ok();

        assert_eq!(
            found
                .iter()
                .map(|skill| (skill.name.as_str(), skill.scope))
                .collect::<Vec<_>>(),
            [("summarise", "user"), ("summarise", "project")]
        );
    }

    #[test]
    fn project_scope_is_found_by_walking_up_from_the_directory_asked_about() {
        let root = scratch("walkup");
        let deep = root.join("a/b/c");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(root.join(".agents/skills/refactor")).unwrap();
        // Claude looks somewhere else, so the same tree answers differently
        // for the two agents.
        let codex = discover(Agent::Codex, &scratch("empty-home"), &deep);
        let claude = discover(Agent::Claude, &scratch("empty-home"), &deep);
        std::fs::remove_dir_all(&root).ok();

        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].name, "refactor");
        assert_eq!(codex[0].scope, "project");
        assert!(claude.is_empty());
    }

    #[test]
    fn antigravity_reads_its_own_skills_directory_and_no_one_elses() {
        let home = scratch("antigravity");
        std::fs::create_dir_all(home.join(".claude/skills/summarise")).unwrap();
        std::fs::create_dir_all(home.join(".agents/skills/refactor")).unwrap();
        std::fs::create_dir_all(home.join(".gemini/skills/summarise")).unwrap();
        let found = discover(Agent::Antigravity, &home, &home);
        std::fs::remove_dir_all(&home).ok();
        // `~/.gemini/skills` is its own; the other two agents' are not, and it
        // has no project scope for the walk upwards to find.
        assert_eq!(
            found
                .iter()
                .map(|skill| (skill.name.as_str(), skill.scope))
                .collect::<Vec<_>>(),
            [("summarise", "user")]
        );
    }
}
