//! `nomoreide setup [claude|codex|gemini|cursor|windsurf] [--force]`.
//!
//! With no agent named it prints the instructions; with one it installs. The
//! instructions are the native ones — `nomoreide mcp`, not `npx -y nomoreide`
//! — because a user who copies a line out of this help should end up with the
//! same thing the command would have written for them.

use std::path::PathBuf;

use nomoreide_core::agent_profiles::debug_setup::{
    install, native_server_command, SetupAgent, SetupError, SetupStatus,
};

const INSTRUCTIONS: &[&str] = &[
    "NoMoreIDE MCP + automatic debugging setup",
    "",
    "Recommended (installs the MCP server and the nomoreide-debug skill):",
    "  nomoreide setup claude [--force]",
    "  nomoreide setup codex [--force]",
    "  nomoreide setup gemini [--force]",
    "",
    "Manual MCP-only setup — Claude Code:",
    "  claude mcp add --transport stdio nomoreide -- nomoreide mcp",
    "",
    "Codex CLI:",
    "  codex mcp add nomoreide -- nomoreide mcp",
    "",
    "Gemini CLI:",
    "  Add to ~/.gemini/settings.json:",
    "  {\"mcpServers\":{\"nomoreide\":{\"command\":\"nomoreide\",\"args\":[\"mcp\"]}}}",
    "",
    "Then verify inside your agent:",
    "  /mcp",
];

/// Returns the process exit code.
pub fn run(arguments: &[String]) -> u8 {
    let force = arguments.iter().any(|argument| argument == "--force");
    let named = arguments.iter().find(|argument| !argument.starts_with('-'));

    let Some(named) = named else {
        for line in INSTRUCTIONS {
            println!("{line}");
        }
        return 0;
    };

    let Some(agent) = SetupAgent::parse(named) else {
        eprintln!("nomoreide: setup agent must be one of: claude, codex, gemini, cursor, windsurf");
        return 1;
    };

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    match install(agent, &cwd, force, &native_server_command()) {
        Ok(result) => {
            println!(
                "Installed NoMoreIDE debugging for {}: MCP {}, skill {}",
                result.agent.id(),
                result.mcp.id(),
                result.skill.id()
            );
            // Worth one line: it is the difference between this install and
            // the npm one, and it is what the user checks when the agent
            // reports the server as failing to start.
            if result.mcp != SetupStatus::Identical {
                println!("The agent will run: {} mcp", result.command);
            }
            for backup in &result.backups {
                println!("Backup: {backup}");
            }
            println!(
                "Start a new {} session, then verify the nomoreide MCP is connected.",
                result.agent.id()
            );
            0
        }
        Err(SetupError::Conflict(detail)) => {
            eprintln!("nomoreide: {detail}");
            1
        }
        Err(SetupError::Failed(detail)) => {
            eprintln!("nomoreide: setup failed: {detail}");
            1
        }
    }
}
