# AI-native opportunities — UX backlog

> Scratchpad of where else to apply the "AI-native" pattern we built for **Add
> Service**. Not scoped or scheduled — just ideas + the user pain each solves and
> the mechanism to reuse. Pick these up in a fresh session.

## What we already shipped (the pattern to reuse)

The Add-Service flow established a reusable conversational pattern in the dock:

- **Entry point** — an `AiSpark` / "AI" affordance on an object hands off to the
  dock via `useAgentDock().sendToAgent({ prompt, source })`.
- **Centralized prompts** — copy lives in `features/agent/prompts/` (one file per
  surface), not inline in components.
- **Agent → UI directives** — the agent emits fenced blocks the dock strips out of
  the prose and renders as interactive UI:
  - ` ```options ` → clickable choice buttons (`OptionList`).
  - ` ```service ` → Start / Open action card (`ServiceActions`).
- **Conversation quality rules** baked into the prompt — ask one question at a
  time, always give an example for free-text answers, point at the 📎 attach
  button for paths.

Everything below is "another surface + a new directive type + a prompt." The
cheaper we make that, the faster these land — see **Building blocks** at the end.

---

## High-value surfaces

### 1. Errors / Error Inbox — "Investigate & fix"
- **Pain:** an error shows up; the user has to copy the stack trace, find the
  file, and reason about it themselves.
- **AI-native:** an "Investigate" button on each incident. The agent reads the
  stack trace + nearby logs + the offending file, explains the root cause, and
  ends with action directives: `open-file` (jump to line), `run-command`
  (reproduce / test), and a "propose fix" diff the user can apply.
- Reuses the existing `error_prompt`; mostly new directive types.

### 2. Services — "Diagnose why it won't start"
- **Pain:** service exits or won't bind; the user digs through logs and port
  conflicts manually.
- **AI-native:** when a service is `exited`/unhealthy, a "Diagnose" button. Agent
  reads logs + port state + health, names the likely cause, and offers actions:
  Restart, free the conflicting port, open the config file, edit the command.
- Builds directly on `ServiceActions` (add `restart`, `open-file`).

### 3. Logs — "Summarize / why did this happen"
- **Pain:** walls of log lines; hard to know what matters.
- **AI-native:**
  - "Summarize" a service's recent logs → short narrative + a `service` restart
    action if it crashed.
  - **Natural-language filtering:** user types "auth errors in the last 10 min";
    agent translates to the existing log query (level/grep/since) and applies it.

### 4. Database — natural language → SQL (guarded)
- **Pain:** the user knows what they want, not the exact SQL/schema.
- **AI-native:** a query box / button: "Show users created today" → agent inspects
  the schema, writes SQL, shows it in a `sql` directive with a **Run** button
  (read-only by default, explicit confirm for writes). Extends today's "explain
  this row".
- Bonus: "Explain this table" and "Suggest indexes" (a pg index-advisor already
  exists in the agent's toolbelt).

### 5. Git — guided commit & change summary
- **Pain:** writing commit messages, understanding a diff before staging.
- **AI-native:**
  - "Draft commit message" from the staged diff → editable text + a **Commit**
    action directive.
  - "Summarize changes" / "what changed and why" on the diff view.
  - Guided branch-from-issue (we have Linear context) and conflict-resolution
    walk-through.

### 6. Terminal — suggest & explain
- **Pain:** "what's the command to…" and "why did this fail."
- **AI-native:** "Ask AI" produces a `run-command` directive (Run button, never
  auto-run) and can explain the last command's output/error inline.

### 7. MCP / first-run setup — conversational onboarding
- **Pain:** wiring NoMoreIDE as an MCP server / installing the agent CLI is fiddly.
- **AI-native:** a guided setup chat (same one-question-at-a-time pattern) that
  detects what's missing and ends with copy-paste/`run-command` actions, then
  verifies with `/mcp`.

---

## Building blocks (do these first — they make the rest cheap)

1. **Generalize the directive protocol.** Today `parseAgentMessage` hard-codes
   `options` and `service`. Promote it to a small registry of fenced directive
   types with a renderer each:
   - `options` (choices) · `service` (start/open) · `open-file` (path:line) ·
     `run-command` (guarded Run) · `sql` (guarded Run) · `commit` (message+Commit)
     · `link` (open URL/page).
   Live in `features/agent/chat/` as `agent-directives.*`. Every feature above is
   then "emit a directive the dock already knows."

2. **Session-level conventions.** The "one question at a time / give examples /
   use option blocks" rules are repeated per-prompt. Move them to a single
   system-level preamble so *every* agent interaction gets them, and per-surface
   prompts only carry the task. (Needs a hook in `agent-runtime.ts` for a system
   prompt / appended instructions.)

3. **Consistent `AiSpark` entry points** on every actionable object — error rows,
   log lines, service rows, db rows, git files — each passing a `source` chip so
   the agent always has context. Mostly wiring, high perceived polish.

4. **Safety/approval reuse.** Mutating directives (`run-command`, `sql` writes,
   `commit`) should route through the dock's existing approval prompt rather than
   firing on click — keep the read-safe boundary the core already enforces.

---

## Notes / cautions
- Directives only render if the agent emits them → keep prompts tight and
  consider the session-level preamble (building block #2) so behavior is
  consistent without repeating instructions.
- Respect existing safety boundaries: `GitManager` is read-safe; destructive Git
  (`commit` is fine, but reset/clean/force-push) stays out. DB writes need an
  explicit confirm. Don't let app features borrow the agent's MCPs — they hold
  their own creds (see the integration-layer note).
- Each of these is a vertical slice (CLAUDE.md): core logic + route + a prompt +
  a directive renderer. Don't grow a central switchboard.
