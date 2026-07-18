# Native Agent Terminal Dock Design

## Summary

Replace the bottom custom agent chat with an elegant terminal dock backed by a real PTY. Each task launches the selected local agent CLI with one complete prompt in the current NoMoreIDE project directory. The native agent session remains interactive throughout, so users normally need no follow-up but can type directly when they want to continue.

This change is intentionally limited to the agent dock. A broader workspace-owned model for services, Git repositories, databases, errors, and terminals will be designed separately.

## Product Goals

- Make it obvious that NoMoreIDE runs the user's real local Claude Code or Codex CLI.
- Give every task a complete initial prompt so it can run without conversational setup.
- Preserve native terminal behaviour, output, colours, approvals, and keyboard controls.
- Keep `Ask AI` actions available throughout the application.
- Isolate unrelated tasks so their context and terminal state do not leak into one another.
- Keep the bottom surface visually quiet, compact, and consistent with the existing application.

## Chosen Approach

Each task gets its own native agent terminal tab.

Reusing one terminal for all tasks was rejected because app actions could arrive while the agent is busy and unrelated tasks would inherit session context. Rendering the current headless event stream in xterm was rejected because it would only look like a terminal while retaining the custom chat protocol and parsing complexity.

## Interaction Design

### Collapsed State

The dock remains a thin bar pinned to the bottom of every page. It shows the selected agent, the active task's concise status, and a subtle expand affordance. It should not compete with the main workbench.

### Composer

Expanding an idle dock reveals a compact prompt composer and provider selector. Submitting a prompt creates a terminal task immediately. Existing feature actions continue to use the shared `sendToAgent` entry point, but that call creates a terminal task rather than a chat turn.

Long generated prompts are passed directly to the agent process. The UI uses the action's short label as the terminal tab title so internal prompt detail does not overwhelm the chrome.

### Task Tabs

Every submitted task opens in a new tab. A tab shows a short task label and a restrained running, exited, or failed indicator. Users can switch between concurrent tasks, stop a running task, and close a task. Closing disposes its PTY session.

The newest user-started task becomes active and opens the dock. Background workflow tasks may create a tab without stealing focus when their existing call specifies background execution.

### Raw Terminal

The active tab is an xterm viewport connected directly to the task's PTY. Keyboard input is always available. The selected agent's native TUI owns rendering, progress, approval prompts, and follow-up input. NoMoreIDE does not parse the agent's prose or synthesize chat bubbles.

The dock remains vertically resizable and remembers a sensible user-selected height. Typography, spacing, tab density, borders, and status treatments should match the existing refined terminal page while keeping the agent identity visible.

## Architecture

### Server

Add an agent-terminal session path on top of the existing terminal session manager. The client submits only:

- a known provider identifier (`claude` or `codex`),
- the complete prompt,
- an optional short label,
- supported task metadata such as background intent.

The server resolves the provider to its configured executable and constructs the arguments. It never accepts an arbitrary executable or shell command from the browser. The PTY is spawned in NoMoreIDE's current project directory using the inherited environment so the local CLI can use the user's authentication and configuration.

Prompts are passed as process arguments, not interpolated into a shell command. Provider-specific invocation construction lives in one core module and is unit tested.

The existing terminal socket transports raw bytes, resize events, input, interrupt, and state. Agent terminal sessions use their own stable IDs and labels but reuse this transport and lifecycle machinery.

### Client

Replace the custom transcript portion of `AgentDock` with an agent-task tab controller and the reusable xterm pane. Preserve the app-wide agent context contract where practical so existing `sendToAgent` callers require minimal changes.

The provider selection remains persistent. `sendToAgent` maps its prompt, label, provider, source, and background behaviour to a newly created agent terminal session. Chat-specific concepts such as parsed directives, conversation turns, queued follow-up turns, and custom approval cards no longer drive the dock.

### Concurrency

Tasks do not queue behind one global agent. Each task owns a separate PTY and can run concurrently. This prevents prompts from being typed into a busy native TUI and avoids cross-task session contamination.

## Safety and Failure Handling

- Only allowlisted local agent providers can be launched.
- Prompts are process arguments and are never shell-interpolated.
- Existing PTY idle and disposal rules apply to agent tasks.
- Stop sends an interrupt or supported termination signal without affecting other tasks.
- Missing CLIs produce a clear dock-level setup message before launch where detection is available.
- Spawn failures and unexpected exits remain visible in the terminal tab with an explicit failed state.
- Reloading reattaches to live server-owned task sessions where the current terminal transport supports it.

## Elegance Requirements

- Keep the collapsed bar visually quiet and no taller than the current dock unless a task status needs attention.
- Use short, human task labels instead of full prompts in tabs.
- Avoid nested cards and excessive toolbars around the terminal.
- Align terminal controls with existing Terminal page patterns.
- Maintain keyboard focus when switching tabs and refit xterm without clipped rows.
- Animate opening, resizing, and task activation subtly; never animate terminal output itself.
- Preserve sufficient contrast and accessible names for provider, tab, stop, close, and expand controls.

## Compatibility Decisions

- Existing feature-level `Ask AI` calls remain supported through `sendToAgent`.
- Native CLI approvals replace custom dock approval cards.
- Structured response directives and chat-only action cards are not parsed from raw terminal output. Product actions that depend on them should be converted to explicit application UI in later focused work.
- Workspace ownership and workspace switching are out of scope.

## Testing

- Unit-test provider-to-executable argument construction and prompt safety.
- Test agent terminal creation rejects unknown providers and never accepts arbitrary commands.
- Test session creation, listing, stopping, closing, reload reattachment, and concurrent tasks.
- Test context actions create isolated tabs with the correct prompt, label, provider, and focus behaviour.
- Test missing CLI and spawn-failure states.
- Verify keyboard input, terminal resize, tab switching, stop/interrupt, and responsive dock layout in the browser.
- Run the existing test suite and production builds for both the web client and server.

