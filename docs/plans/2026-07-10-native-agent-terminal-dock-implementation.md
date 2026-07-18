# Native Agent Terminal Dock Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the custom bottom agent chat with an elegant, tabbed raw-terminal dock that launches a fresh interactive Claude Code or Codex PTY for every complete task prompt.

**Architecture:** Extend the existing terminal session API with an allowlisted `agent` launch request whose executable and arguments are derived server-side. Reuse the existing PTY transports and xterm rendering, then adapt the app-wide `sendToAgent` contract so every feature action creates an isolated agent terminal tab instead of a parsed chat turn. Implement the same allowlisted launch contract in the Node and Tauri backends.

**Tech Stack:** TypeScript, React 19, xterm.js, node-pty, Vitest, Rust, Tauri 2, portable-pty, Tailwind CSS 4.

---

### Task 1: Define and test safe native agent invocations

**Files:**
- Create: `src/core/agent-terminal.ts`
- Create: `test/agent-terminal.test.ts`

**Step 1: Write the failing provider invocation tests**

Cover the exact allowlisted contract:

```ts
import { describe, expect, test } from "vitest";
import { buildInteractiveAgentInvocation } from "../src/core/agent-terminal.js";

describe("buildInteractiveAgentInvocation", () => {
  test("launches Claude interactively with the prompt as one argument", () => {
    expect(buildInteractiveAgentInvocation("claude", "Fix `api`; then test it"))
      .toEqual({ shell: "claude", args: ["Fix `api`; then test it"] });
  });

  test("launches Codex in inline native TUI mode", () => {
    expect(buildInteractiveAgentInvocation("codex", "Review this workspace"))
      .toEqual({ shell: "codex", args: ["--no-alt-screen", "Review this workspace"] });
  });

  test("rejects unknown providers", () => {
    expect(() => buildInteractiveAgentInvocation("bash", "echo unsafe"))
      .toThrow("Unsupported agent provider");
  });

  test("rejects an empty prompt", () => {
    expect(() => buildInteractiveAgentInvocation("claude", "   "))
      .toThrow("Prompt is required");
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npm test -- --run test/agent-terminal.test.ts`

Expected: FAIL because `src/core/agent-terminal.ts` does not exist.

**Step 3: Implement the minimal allowlisted builder**

Create exported types `InteractiveAgentProvider = "claude" | "codex"` and `InteractiveAgentInvocation`, validate a trimmed non-empty prompt, use the existing `NOMOREIDE_CLAUDE_BIN` and `NOMOREIDE_CODEX_BIN` overrides, and return arguments without shell interpolation. Use `--no-alt-screen` for Codex so scrollback behaves naturally in a dock.

**Step 4: Run the focused test**

Run: `npm test -- --run test/agent-terminal.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/agent-terminal.ts test/agent-terminal.test.ts
git commit -m "feat: define safe native agent terminal launches"
```

### Task 2: Add agent task metadata to terminal sessions

**Files:**
- Modify: `src/core/terminal-manager.ts`
- Modify: `src/core/terminal-session.ts`
- Modify: `test/terminal-manager.test.ts`
- Modify: `test/terminal-session.test.ts`

**Step 1: Write failing metadata tests**

Add assertions that a session created with:

```ts
manager.create({}, {
  shell: "codex",
  args: ["--no-alt-screen", "Fix tests"],
  label: "Fix tests",
  kind: "agent",
  provider: "codex",
});
```

returns and retains `kind: "agent"` and `provider: "codex"` in `create()`, `snapshot()`, and `list()`. Confirm existing plain and service sessions remain compatible when those fields are absent.

**Step 2: Run the focused tests to verify failure**

Run: `npm test -- --run test/terminal-manager.test.ts test/terminal-session.test.ts`

Expected: FAIL because session snapshots do not expose agent metadata.

**Step 3: Add optional typed metadata**

Extend `TerminalSnapshot`, `TerminalSessionOptions`, and `TerminalSpawnOptions` with:

```ts
kind?: "shell" | "service" | "agent";
provider?: "claude" | "codex";
```

Store both fields in `TerminalSession` and include them in every snapshot. Do not add a separate session manager.

**Step 4: Run focused tests**

Run: `npm test -- --run test/terminal-manager.test.ts test/terminal-session.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/terminal-manager.ts src/core/terminal-session.ts test/terminal-manager.test.ts test/terminal-session.test.ts
git commit -m "feat: track agent terminal session metadata"
```

### Task 3: Expose safe agent session creation over HTTP

**Files:**
- Modify: `src/web/routes/terminal-routes.ts`
- Modify: `test/web-terminal.test.ts`

**Step 1: Write failing route tests**

Add HTTP tests for `POST /api/terminal/sessions` with:

```json
{
  "agent": {
    "provider": "codex",
    "prompt": "Fix the failing test",
    "label": "Fix failing test"
  }
}
```

Assert the fake terminal manager receives `shell: "codex"`, `args: ["--no-alt-screen", "Fix the failing test"]`, `kind: "agent"`, `provider: "codex"`, and a capped/sanitized label. Add 400 tests for an unknown provider and blank prompt. Add a regression assertion that a body containing `shell`, `command`, or `args` cannot control the launched executable.

**Step 2: Run the route tests to verify failure**

Run: `npm test -- --run test/web-terminal.test.ts`

Expected: FAIL because the route ignores `agent`.

**Step 3: Implement the HTTP route branch**

Before the existing service/plain-shell branches, validate the nested `agent` object using Zod, call `buildInteractiveAgentInvocation`, and pass only the derived `shell` and `args` to `terminalManager.create`. Use a default label such as `Codex task` or `Claude task`, trim whitespace, and cap labels at 60 characters.

**Step 4: Run route and core tests**

Run: `npm test -- --run test/agent-terminal.test.ts test/web-terminal.test.ts test/terminal-manager.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/web/routes/terminal-routes.ts test/web-terminal.test.ts
git commit -m "feat: create allowlisted agent terminal sessions"
```

### Task 4: Extend the shared client API and website mock

**Files:**
- Modify: `src/web/client/src/lib/api/terminal-api.ts`
- Modify: `src/web/client/src/lib/api/terminal-http.ts`
- Modify: `src/web/client/src/lib/api/terminal-tauri.ts`
- Modify: `src/web/client/src/lib/api/terminal.ts`
- Modify: `src/web/client/src/lib/api/tauri-bridge.ts`
- Modify: `website/src/mock-api.ts`
- Create: `test/agent-terminal-api.test.ts`

**Step 1: Write failing API contract tests**

Test the source contract and HTTP request serialization for:

```ts
createAgentTerminalSession({
  provider: "claude",
  prompt: "Diagnose the API service",
  label: "Diagnose API",
});
```

Assert `TerminalSessionInfo` includes optional `kind` and `provider`, and the request body nests the allowlisted fields under `agent`.

**Step 2: Run the focused test to verify failure**

Run: `npm test -- --run test/agent-terminal-api.test.ts`

Expected: FAIL because the client method does not exist.

**Step 3: Extend the API seam**

Add:

```ts
export interface CreateAgentTerminalOptions {
  provider: "claude" | "codex";
  prompt: string;
  label?: string;
}

createAgentTerminalSession(opts: CreateAgentTerminalOptions): Promise<TerminalSessionInfo>;
```

Implement it in both backends and export the dispatcher from `terminal.ts`. Update the website mock so its embedded dashboard returns a plausible running agent session instead of falling through to `{ ok: true }`.

**Step 4: Run focused tests and build the client**

Run: `npm test -- --run test/agent-terminal-api.test.ts test/website-build-preflight.test.ts`

Run: `npm run build`

Expected: tests PASS and build exits 0.

**Step 5: Commit**

```bash
git add src/web/client/src/lib/api/terminal-api.ts src/web/client/src/lib/api/terminal-http.ts src/web/client/src/lib/api/terminal-tauri.ts src/web/client/src/lib/api/terminal.ts src/web/client/src/lib/api/tauri-bridge.ts website/src/mock-api.ts test/agent-terminal-api.test.ts
git commit -m "feat: expose agent terminal client API"
```

### Task 5: Implement the allowlisted Tauri agent PTY

**Files:**
- Modify: `src-tauri/src/commands/terminal.rs`
- Modify: `src-tauri/src/lib.rs` only if a separate command is chosen
- Modify: `src/web/client/src/lib/api/tauri-bridge.ts`
- Add Rust unit tests inside: `src-tauri/src/commands/terminal.rs`

**Step 1: Write failing Rust tests for command derivation**

Extract a pure helper that maps `claude` and `codex` to `CommandBuilder` inputs. Test that Claude receives only the prompt, Codex receives `--no-alt-screen` followed by the prompt, blank prompts fail, and any other provider fails.

**Step 2: Run the Rust tests to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml terminal`

Expected: FAIL because the helper and agent request fields do not exist.

**Step 3: Extend the Tauri terminal command**

Accept an optional typed agent request alongside the existing service and cwd arguments. Derive the executable in Rust, set the workspace cwd, seed `PATH` with `service_path()`, and launch it through `portable-pty`. Expand `TerminalSession` with optional `label`, `kind`, `provider`, `cwd`, `state`, `cols`, `rows`, and `shell` fields needed by the shared TypeScript contract. Keep plain and service terminal creation working.

Do not accept a browser-provided executable or arguments. Use `NOMOREIDE_CLAUDE_BIN` and `NOMOREIDE_CODEX_BIN` when set, matching Node behaviour.

**Step 4: Run Rust tests and checks**

Run: `cargo test --manifest-path src-tauri/Cargo.toml terminal`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS and check exits 0.

**Step 5: Commit**

```bash
git add src-tauri/src/commands/terminal.rs src-tauri/src/lib.rs src/web/client/src/lib/api/tauri-bridge.ts
git commit -m "feat: launch native agent terminals in desktop app"
```

### Task 6: Extract a reusable raw terminal viewport

**Files:**
- Create: `src/web/client/src/features/terminal/terminal-viewport.tsx`
- Modify: `src/web/client/src/features/terminal/terminal-pane.tsx`
- Modify: `test/terminal-view.test.tsx`

**Step 1: Write failing component tests**

Add static rendering and mocked lifecycle coverage that verifies the reusable viewport exposes the xterm mount, accepts `active`, connects to a supplied session ID, supports focus/refit on tab activation, and does not render the Terminal page's shell-specific toolbar.

**Step 2: Run the focused test to verify failure**

Run: `npm test -- --run test/terminal-view.test.tsx`

Expected: FAIL because `TerminalViewport` does not exist.

**Step 3: Extract transport and xterm ownership**

Move xterm creation, web/Tauri transports, input, output, resize, connection state, focus, and cleanup from `TerminalPane` into `TerminalViewport`. Keep the Terminal page header and restart/stop controls in `TerminalPane`. Give the new component a small status callback so the agent dock can display state without duplicating transport code.

**Step 4: Run terminal UI and socket tests**

Run: `npm test -- --run test/terminal-view.test.tsx test/web-terminal.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/web/client/src/features/terminal/terminal-viewport.tsx src/web/client/src/features/terminal/terminal-pane.tsx test/terminal-view.test.tsx
git commit -m "refactor: share raw terminal viewport"
```

### Task 7: Replace chat state with tabbed agent terminal task state

**Files:**
- Modify: `src/web/client/src/features/agent/chat/agent-context.tsx`
- Create: `src/web/client/src/features/agent/terminal/use-agent-terminal-tasks.ts`
- Create: `test/agent-terminal-context.test.tsx`
- Modify: `src/web/client/src/features/workflows/workflow-run-context.tsx` or the actual workflow caller only if its return assumptions require it

**Step 1: Write failing context behaviour tests**

Test these behaviours through `AgentProvider`:

- `sendToAgent({ prompt, label })` creates a fresh agent terminal session.
- Every call creates an isolated task even while another task is running.
- normal sends open the dock and activate the new task;
- `background: true` creates a task without stealing focus;
- `draft` mode opens the composer with the prompt but does not create a session;
- provider selection is persistent;
- `insertPath` still adds a path to the draft;
- `closeTask` disposes only the selected terminal session.

**Step 2: Run the new context test to verify failure**

Run: `npm test -- --run test/agent-terminal-context.test.tsx`

Expected: FAIL because context still owns chat turns and streaming state.

**Step 3: Implement terminal task state**

Create a hook owning `tasks`, `activeTaskId`, `creating`, `error`, and lifecycle actions. Preserve the existing `sendToAgent` input shape so feature callers do not need a broad rewrite. Remove global streaming queues: each call can launch concurrently. Keep any temporary compatibility fields only when a current consumer genuinely needs them; do not simulate chat turns.

**Step 4: Run context and feature source tests**

Run: `npm test -- --run test/agent-terminal-context.test.tsx test/git-ai-input-actions-source.test.ts test/product-docs.test.ts`

Expected: PASS, or update assertions that specifically require obsolete chat parsing to assert terminal task dispatch instead.

**Step 5: Commit**

```bash
git add src/web/client/src/features/agent/chat/agent-context.tsx src/web/client/src/features/agent/terminal/use-agent-terminal-tasks.ts test/agent-terminal-context.test.tsx
git commit -m "feat: dispatch agent actions as isolated terminal tasks"
```

### Task 8: Build the elegant agent terminal dock

**Files:**
- Replace: `src/web/client/src/features/agent/chat/agent-dock.tsx`
- Create: `src/web/client/src/features/agent/terminal/agent-terminal-tabs.tsx`
- Create: `src/web/client/src/features/agent/terminal/agent-terminal-composer.tsx`
- Create: `src/web/client/src/features/agent/terminal/agent-terminal-dock.tsx`
- Modify: `src/web/client/src/app.tsx`
- Create: `test/agent-terminal-dock.test.tsx`

**Step 1: Write failing UI tests**

Verify the dock renders:

- a quiet collapsed bar with selected provider and active status;
- a compact composer when expanded with no active task;
- short labelled tabs with running/exited/failed indicators;
- close and interrupt controls with accessible names;
- one mounted `TerminalViewport` per task, hiding inactive panes to preserve PTYs;
- a resizable expanded surface;
- no chat transcript, markdown bubbles, parsed directives, or custom approval rows.

Add interaction tests for submit, provider switch, tab activation, stop, close, and draft prefilling.

**Step 2: Run the UI test to verify failure**

Run: `npm test -- --run test/agent-terminal-dock.test.tsx`

Expected: FAIL because the terminal dock components do not exist.

**Step 3: Implement the dock components**

Follow the design constraints:

- retain the current 36px collapsed height;
- use a restrained tab strip and a single compact toolbar;
- show short human labels, never full generated prompts, in chrome;
- reuse provider logos and the existing provider switcher behaviour;
- align xterm typography and colour tokens with the Terminal page;
- preserve vertical drag resize, focus, and subtle height transitions;
- do not wrap the terminal in nested decorative cards;
- keep keyboard input always enabled;
- use native agent approvals inside the PTY.

Replace the `AgentDock` import in `app.tsx` with `AgentTerminalDock`. Remove obsolete dock callback props used only for parsed response cards (`onOpenService`, `onOpenSqlConsole`) after confirming no other consumer needs them.

**Step 4: Run UI tests and lint**

Run: `npm test -- --run test/agent-terminal-dock.test.tsx test/terminal-view.test.tsx`

Run: `npm run lint`

Expected: tests PASS and lint exits 0.

**Step 5: Commit**

```bash
git add src/web/client/src/features/agent src/web/client/src/app.tsx test/agent-terminal-dock.test.tsx
git commit -m "feat: replace agent chat with elegant terminal dock"
```

### Task 9: Remove obsolete chat-only runtime and repair dependent surfaces

**Files:**
- Delete when unreferenced: `src/web/client/src/features/agent/chat/chat-markdown.tsx`
- Delete when unreferenced: `src/web/client/src/features/agent/chat/chat-markdown.css`
- Delete when unreferenced: `src/web/client/src/features/agent/chat/message-options.tsx`
- Delete when unreferenced: `src/web/client/src/features/agent/chat/streaming-ui.tsx`
- Delete when unreferenced: `src/web/client/src/features/agent/chat/use-agent-chat.ts`
- Delete when unreferenced: `src/web/client/src/lib/api/agent-chat-api.ts`
- Delete when unreferenced: `src/web/client/src/lib/api/agent-chat-http.ts`
- Delete when unreferenced: `src/web/client/src/lib/api/agent-chat-tauri.ts`
- Delete when unreferenced: `src/web/client/src/lib/api/agent-chat.ts`
- Modify: `src/web/client/src/lib/api/index.ts`
- Modify: `src/web/client/src/features/agent/agent-view.tsx`
- Modify or delete obsolete tests: `test/agent-conversation-health.test.tsx`, `test/agent-runtime.test.ts`
- Keep server headless runtime files if MCP/workflows still reference them.

**Step 1: Find exact live references**

Run: `rg -n "useAgentChat|agent-chat|ChatMarkdown|parseAgentMessage|ConversationHealth|turns|approvals" src test website`

Expected: a finite list of chat-only consumers to migrate or remove.

**Step 2: Add or update failing tests for the Agent page**

Change the Agent page's conversation-specific controls to link/focus the live terminal dock or show recent native task tabs. Test that switching the viewed agent also updates the dock provider without requiring chat turns.

**Step 3: Remove only dead custom-chat code**

Delete modules after `rg` proves they are unreferenced. Preserve `src/core/agent-runtime.ts`, `/api/agent/chat`, and Tauri headless agent commands if workflows or another non-dock feature still uses them. Do not combine removal with unrelated agent profile work.

**Step 4: Run the full TypeScript test and build checks**

Run: `npm test`

Run: `npm run build`

Expected: all tests PASS and build exits 0.

**Step 5: Commit**

```bash
git add -A src/web/client/src/features/agent src/web/client/src/lib/api test
git commit -m "refactor: remove obsolete agent chat presentation"
```

### Task 10: Verify the complete native terminal experience

**Files:**
- Modify if needed: `docs/usage-guide.md`
- Modify if needed: `docs/ai-agent-guide.md`
- Modify: `website/src/mock-api.ts`

**Step 1: Run all automated verification**

Run: `npm test`

Run: `npm run lint`

Run: `npm run build`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: every command exits 0.

**Step 2: Start the application and perform browser verification**

Run: `npm run dev`

Verify with the browser tooling:

1. The collapsed dock is quiet and does not cover page content.
2. A manual prompt launches the selected local CLI with its native TUI.
3. A service or Git `Ask AI` action launches a separate labelled tab with the full generated prompt.
4. Two tasks can run concurrently without prompt contamination.
5. Terminal typing, approval selection, resizing, scrollback, tab switching, interrupt, and close work.
6. Reload reattaches to live tasks.
7. Missing-provider and failed-spawn states are clear and visually contained.
8. The website mock does not emit unhandled API warnings or white-screen.

**Step 3: Verify desktop behaviour**

Run: `npm run tauri:dev`

Repeat launch, input, resize, provider, stop, close, and concurrent-task checks in the desktop build.

**Step 4: Update user documentation**

Document that the dock launches the real local agent CLI, each task is isolated, generated prompts are sent automatically, and users can continue typing directly in the same raw terminal.

**Step 5: Commit final verification fixes and docs**

```bash
git add docs website/src/mock-api.ts src src-tauri test
git commit -m "docs: explain native agent terminal workflow"
```

