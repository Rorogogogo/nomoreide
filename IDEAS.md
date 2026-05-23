# Ideas for Vibe Coders

High-leverage additions beyond the current Services / Logs / Git / Agent dashboard.

## 1. Env/Secrets Manager
View and edit `.env` files per service in one place, with masking. Bonus: "inject into running process" so they don't restart-and-pray.

## 2. Error Inbox (killer feature)
Auto-tail logs across all services. Surface stack traces / `ERROR` lines into a single feed. Each entry has a **"Copy to agent"** button that builds a prompt with:
- the stack trace
- recent diff in the affected file
- last N log lines for context

Turns "I have a bug" → one click → ready-to-paste prompt for Claude/Codex.

## 3. HTTP Request Inspector
Proxy on the service port that records requests/responses. Replay, share, or pipe to an AI agent without setting up Postman/Charles.

## 4. DB Peek
Lightweight read-only table browser (pg-mcp already in the ecosystem). "Explain this row to the agent" action attaches the row + schema to a prompt.

## 5. Task/PR Cockpit
Linear issues + GitHub PR checks for the current branch in one panel. Project already integrates Linear and Git — this is glue.

## 6. Snapshot / Restore
Git stash-like checkpoints tied to "before agent edit". One-click revert when an AI-generated change goes sideways — no `git reflog` puzzle.

---

**Connecting theme:** vibe coders don't context-switch well. Anything that turns "tab through 5 tools to assemble a prompt" into a single button is the win.
