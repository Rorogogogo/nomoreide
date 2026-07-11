# Agent Terminal Prompt Injection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Start the selected interactive agent in the dock PTY and submit the complete staged prompt into that session.

**Architecture:** Remove task prompts from provider command-line arguments. Add a shared terminal-input encoding rule and have both Node and Rust session-creation paths write the initial prompt to the newly spawned agent PTY, while leaving shell/service sessions unchanged.

**Tech Stack:** TypeScript, Node PTY, Rust, portable-pty, Vitest, Cargo test.

---

### Task 1: Specify provider launch behavior

**Files:**
- Modify: `test/agent-terminal.test.ts`
- Modify: `src/core/agent-terminal.ts`

1. Change the invocation tests to require `claude` and `codex --no-alt-screen` without positional prompts and add a test for terminal-safe initial-prompt encoding.
2. Run `npm test -- test/agent-terminal.test.ts` and confirm the new assertions fail for the current positional-argument behavior.
3. Implement the smallest invocation and prompt-encoding change.
4. Re-run the focused test and confirm it passes.

### Task 2: Inject prompts in the Node PTY path

**Files:**
- Modify: `test/terminal-routes.test.ts` or the closest existing terminal route/session test
- Modify: `src/web/routes/terminal-routes.ts`
- Modify: `src/core/terminal-manager.ts` only if session creation cannot atomically accept initial input

1. Add a route/session regression test proving agent creation starts the provider and writes the full prompt to that session.
2. Run the focused test and confirm it fails because no PTY input is written.
3. Inject the encoded prompt immediately after successful agent PTY creation, with cleanup on write failure.
4. Re-run the focused tests and confirm they pass.

### Task 3: Inject prompts in the Rust/Tauri PTY path

**Files:**
- Modify: `src-tauri/src/commands/terminal.rs`

1. Change Rust unit tests to require prompt-free provider arguments and add coverage for complete initial-input encoding/writing.
2. Run the focused Cargo test and confirm it fails against current behavior.
3. Implement initial prompt injection after spawning the agent PTY and fail cleanly if injection fails.
4. Re-run the focused Cargo tests and confirm they pass.

### Task 4: Regression verification

**Files:**
- Modify only if a failing regression exposes an in-scope defect.

1. Run the agent terminal JavaScript tests.
2. Run the Rust terminal tests.
3. Run TypeScript and the production build.
4. Review `git diff` to ensure unrelated working-tree changes were preserved.
