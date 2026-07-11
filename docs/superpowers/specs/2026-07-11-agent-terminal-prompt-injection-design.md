# Agent Terminal Prompt Injection Design

## Goal

Submitting a task from the bottom dock must start the selected Claude Code or Codex interactive terminal and deliver the complete staged prompt into that same PTY session.

## Design

Agent-session creation becomes an explicit two-stage operation. The backend starts the selected agent executable without using the task prompt as a positional command-line argument. After the PTY exists, the backend writes the prompt through the PTY input stream as the first user turn, preserving the interactive process for follow-up input, approvals, output, and scrollback.

Both runtime implementations follow the same contract: the Node terminal manager and Rust/Tauri terminal manager launch the provider, inject the initial prompt, and only then return a successful agent session. Ordinary shell and service terminals remain unchanged.

Prompt injection uses terminal-safe input framing so multiline prompts are treated as one composed submission rather than several separate turns. A failure to write the initial prompt fails session creation and cleans up the partially created PTY instead of leaving an empty terminal tab.

## Testing

Focused tests will first prove that provider invocations contain no positional prompt and that agent-session creation writes the complete prompt to the new PTY. Existing provider validation, labels, working-directory selection, and normal terminal behavior remain covered. The relevant JavaScript and Rust suites will run after the fix, followed by TypeScript/build verification if the focused suites pass.
