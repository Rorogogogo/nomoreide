# AI-Native Action Layer

Date: 2026-05-29
Status: Draft for discussion

## Summary

NoMoreIDE should evolve from a dashboard that can copy prompts into a product where every important runtime object can become an AI task. The bottom agent dock should become the native execution surface for those tasks: it receives structured context, streams the real Claude/Codex response, shows tool calls and approval prompts, and keeps the user anchored to the object they acted on.

The core product pattern is not "more AI buttons." It is an AI action layer shared by Services, Database, Errors, Git, Terminal, and future features.

## Product Direction

Current surfaces already expose useful context:

- Services know command, cwd, port, health, logs, env summaries, process state, and terminal scope.
- Database knows connection, engine, table schema, sampled rows, and selected row values.
- Error Inbox knows incidents, stack traces, recent logs, related diffs, and repro bundles.
- Git knows changed files, diffs, repository roots, branches, and selected files.
- Terminal knows command output and current workspace/session context.
- The global bottom agent dock already streams real agent CLI sessions and supports approvals.

The next step is to make those surfaces send intent directly into the dock instead of only copying prompt text to the clipboard.

## Core UX Pattern

Important objects should expose contextual AI actions:

- Service: diagnose, fix startup failure, explain config, find env issue, inspect folder, generate test command.
- Database row/table: explain row, find related records, generate SQL, connect row to an error, inspect suspicious values.
- Error: investigate, reproduce, patch, run relevant test, explain failure.
- Git diff/file: review, explain change, split commit, write PR notes, find risky edits.
- Folder: inspect app type, infer dev command, register as service, discover ports and tests.
- Terminal/log output: explain failure, suggest next command, diagnose service.

These actions should feel like natural object actions, not generic chat prompts.

Each object exposes **one primary `Ask AI` affordance**, not a pair of buttons. The old
"Ask AI / Copy prompt" split is the timid version — the real choice is not *send vs copy*,
it is *send now vs prefill the draft and wait*. Clipboard copy does not disappear, but it
stops being a primary button: it moves into a secondary "…" / right-click fallback for
users who want to paste into their own agent. One primary affordance per object; behavior
varies by risk (see Decisions).

## Visual Pattern ("the spark")

If every meaningful object can talk to AI, the affordance has to be *learnable* — the same
mark, in the same gesture grammar, everywhere. The goal is that a user sees it once and
knows that anything wearing it can become an agent task.

**One glyph, one accent.** Standardize on a single icon and accent color that means "AI
lives here." Today this is inconsistent: the DB row and nav use `Bot`, the dock uses
`Sparkles`, the DB connection wizard uses `Wand2`. Pick one — recommend `Sparkles` (already
the dock's mark) — and use it for every AI affordance so the eye learns it. The accent color
should be distinct from the app's normal action color.

**Latent, resolves on intent.** The affordance is quiet by default and solidifies on
hover / focus / selection. An always-on button on every row is noise; a ghosted spark that
sharpens when you reach for the object is not.

**Gesture grammar — identical on every surface:**

- **Click the spark** → the object's primary intent (auto-send or prefilled draft per the
  risk rule).
- **Caret / right-click** → the full action menu (explain, fix, generate SQL, review…).
- **Select something** (a row, a range of terminal output, several git files) → a floating
  contextual action bar carrying the spark appears: "Ask AI about selection." This is the
  catch-all that makes *arbitrary* things askable without a visible button on everything.

**Three containers, one mark** — scale the affordance to the object's density, never the
glyph:

1. **Inline spark** — compact rows (DB row, git file, error list item): an icon button that
   appears on hover/select.
2. **Labeled `Ask AI` button** — hero surfaces with a header (Service detail, Error detail,
   Terminal).
3. **Selection bar** — a floating bar for arbitrary selections (terminal output, multi-file
   git, a text range).

**Source anchoring is bidirectional.** When an action fires, the dock's user turn carries a
source chip (`✦ DB row · users#123`) that links back to the object. While that task is live,
the source object itself shows a subtle "active in agent" state (filled spark / accent
border) so the user never loses the thread between the object and the conversation.

**Send vs draft, made visible:**

- **Auto-send** → the dock opens already streaming.
- **Draft** → the dock opens with the prompt prefilled and focused, source chip attached,
  Send emphasized. The prefilled-but-unsent draft *is* the visual signal "you're about to
  send this — edit or confirm."

## Agent Dock Behavior

The bottom dock should become the product brain:

- Opens automatically when an AI action is invoked.
- Shows the user task as a normal chat turn.
- Streams the selected agent's response through the existing SSE path.
- Shows tool calls inline.
- Shows approval prompts for risky actions.
- Keeps a visible link or label for the source object, such as `DB row: users#123` or `Service: api`.
- Keeps clipboard copy as a fallback for users who want to paste into another agent.

Low-risk actions should auto-send immediately. Examples:

- Explain this DB row.
- Explain this error.
- Review this diff.

Higher-risk actions should open with a prepared draft or instruct the agent to inspect first and confirm before mutating anything. Examples:

- Fix this service.
- Register this folder as a service.
- Change config.
- Run destructive commands.

## Technical Shape

Add a frontend-level agent controller/provider at the app root. Components should not each own separate chat state or call the streaming API directly.

The provider should expose actions like:

```ts
sendToAgent({
  prompt,
  source,
  mode: "send" | "draft",
});

stageAgentDraft({
  prompt,
  source,
});
```

Then features can call this shared interface:

```ts
sendToAgent({
  source: { type: "database-row", label: "users row" },
  mode: "send",
  prompt: buildAgentIntent({
    intent: "explain-database-row",
    target: { connection, table, row },
  }),
});
```

Prompt/context generation should also be centralized. Instead of every component writing its own prompt strings, add a shared AI intent builder that takes a target object and intent.

Possible structure:

```ts
buildAgentIntent({
  intent: "diagnose-service",
  target: { type: "service", name: "api" },
  context: { health, logs, envSummary, cwd, port },
});
```

This keeps the UX consistent and makes future AI actions easier to add.

## Session & Concurrency Model

This is the one question that blocks the provider API: when *any* object can fire a task into
*one* dock, what happens to threading and timing? Today's code answers it by accident, not by
design, and the accident is wrong for the new pattern.

**What exists today.** The backend is stateless per request — each `POST /api/agent/chat`
spawns a fresh `claude`/`codex` process and continuity is faked by passing `resumeSessionId`
so the CLI resumes its own on-disk session (`agent-chat-routes.ts`, `agent-runtime.ts`). The
backend can therefore run several agent processes at once. The **frontend cannot**: the dock
holds a single `sessionRef`, a single flat `turns[]`, and `send` **silently early-returns
while streaming** (`use-agent-chat.ts`). So an `Ask AI` fired while a previous turn is still
streaming is *dropped with no feedback* — acceptable when the only entry point was the dock's
own input box, unacceptable when every object in the app is an entry point.

Three independent sub-decisions:

### 1. Continuity — shared thread or fresh per action?

A single resumed session means "explain DB row `users#123`" then "diagnose service `api`"
run in the *same* agent context — the service diagnosis inherits the DB row.

- **Shared (today's behavior):** cheaper (warm cache), and cross-object correlation is
  actually a *listed feature* ("connect row to an error"). Downside: context bleed — unrelated
  investigations contaminate each other and tokens pile up.
- **Fresh per action:** clean, no bleed, each object-task is self-contained. Downside: loses
  the correlation that makes a workbench valuable, and pays cold-start every time.

**Recommendation:** keep **one continuous thread by default** (correlation is a feature here),
with the per-turn **source chip** as the anchor and an explicit **"New chat"** control to drop
context (the existing `clear()` already resets `sessionRef` + `turns` — just surface it). Do
*not* silently fork sessions per object; make starting fresh a deliberate user act.

### 2. Concurrency — action fired while a turn is streaming?

Options, from least to most work:

| Policy | Behavior | Cost |
|---|---|---|
| **Reject + toast** | "Agent is busy — stop the current task first." | trivial; loses the intent |
| **Queue** *(recommended)* | New action appears as a pending user turn, sent when the current run finishes; a visible **Stop** lets the user jump the queue. | small; never drops intent |
| **Interrupt** | Abort the in-flight run, start the new one immediately. | small; throws away an answer in progress |
| **Parallel** | Run both at once in separate sessions. | large; needs multi-thread UI (below) |

**Recommendation: queue**, with Stop available. Firing an action should *never* silently do
nothing (today's bug). Queue preserves intent without the jarring loss of interrupt; the user
who wants the new thing *now* hits Stop.

### 3. Identity — one dock thread vs. per-object threads (tabs)?

- **Single thread (recommended for MVP):** one scrollback, source chips disambiguate turns.
  Simple, ships now, matches the single-`sessionRef` reality.
- **Per-object threads:** a tab/thread per source object — cleanest mental model and the only
  way to get true parallelism, but a real UI build (multiple `sessionRef`s, multiple SSE
  streams, tab management). The backend already supports it, so this is *deferrable, not
  blocked*. Revisit once the single-thread pattern proves out.

### Provider API consequence

These decisions pin the `sendToAgent` contract: it appends to the one shared thread, and when
the dock is streaming it **enqueues** rather than rejecting or interrupting. Sketch:

```ts
sendToAgent({
  prompt,
  source,                       // { type, label, href? } → renders the source chip
  mode: "send" | "draft",       // auto-send vs. prefill-and-wait (risk rule)
}): { queued: boolean };        // queued=true when a run was already in flight

// Surfaced controls the dock already needs:
stopAgent();                    // jump the queue / interrupt current run
newAgentThread();               // = clear(): drop session context for a fresh start
```

## First High-Value Flows

1. Database row AI action

Replace the current hover-only "copy prompt" behavior (`table-grid.tsx` writes
`buildRowPrompt(...)` to the clipboard) with a single `Ask AI` spark on the row. It
auto-sends the existing row/schema prompt to the dock and streams the answer. Clipboard
copy survives in the row's "…" / right-click menu.

2. Error Inbox AI action

Replace `Copy to agent` (`incident-detail.tsx` writes `getErrorPrompt(id)` to the clipboard)
with a single `Ask AI` button that auto-sends the debugging prompt to the dock. Clipboard
copy survives as a secondary action.

3. Service context AI action

Add `Ask AI` actions for service health/context so the user can diagnose a service without manually opening logs, copying context, and writing a prompt.

4. Add service from folder

**The agent never writes config.** It inspects and infers; NoMoreIDE does the write through
its existing validated path (`POST /api/services` → `configStore.registerService`). This
matters because the dock's agent is spawned as a plain `claude --print` / `codex exec`
(`agent-runtime.ts`) with a cwd and a permission mode — it is *not* given the NoMoreIDE MCP
server, so it has no reliable config-write tool anyway. Keeping the write inside NoMoreIDE
also keeps it on the Zod-validated path instead of the agent's bash.

Flow:

```text
Inspect this folder and propose a NoMoreIDE service for it.
Folder: /absolute/path

Infer the service name, dev command, port, working directory, test command if obvious, and
whether it is local or docker-compose. Inspect first (package files, compose files, README,
env files, likely ports). Do not change anything — end with the proposed service as a fenced
JSON block.
```

1. `AI discover from folder` opens the dock with the inspect task (draft mode — it touches
   the filesystem and the user may want to scope it).
2. The agent inspects (read-only file/bash tools) and ends with a structured proposal.
3. NoMoreIDE materializes a **prefilled Add Service form** from that proposal.
4. The user reviews and confirms; the existing `POST /api/services` write runs.

"Inspect first, then confirm" becomes literal UI — a prefilled form the user submits — not a
polite instruction the agent might ignore.

## Design Principles

- AI actions should be object-aware, not generic.
- The user should not need to assemble context manually.
- The dock should remain the single streaming surface.
- Clipboard copy should remain as a fallback.
- Risky actions should require confirmation before mutating config, files, services, or git state.
- The first implementation should prove the pattern in two or three high-value surfaces before expanding everywhere.
- The architecture should make adding future AI actions cheap and consistent.

## Decisions

- **Single `Ask AI` affordance per object, not a button pair.** Clipboard copy is a secondary
  "…" / right-click fallback, never a primary button.
- **Auto-send vs. draft is decided by risk, not left to the user:**

  | Action shape | Behavior |
  |---|---|
  | Read-only, one obvious intent | **Auto-send.** Explain row, explain error, review diff, diagnose service. |
  | Mutates state, or the prompt benefits from user-added constraints | **Open dock, prefill draft, wait for Send.** Fix service, register folder, change config. |

- **Service registration from a folder produces an editable prefilled form, not a direct
  write.** The agent inspects and proposes; NoMoreIDE writes via `POST /api/services` after
  the user confirms (see Flow #4).
- **Two confirmation gates are independent layers, do not conflate them:** draft-vs-send
  gates *the prompt the user sends*; the existing approval prompts (`approval_request` →
  allow/deny in `use-agent-chat.ts`) gate *tool calls the agent makes mid-run*. A low-risk
  auto-send can still hit a tool approval; a drafted prompt the user sends can still produce
  approvals downstream.

## Open Questions

- How much source-object metadata should the dock show during a task beyond the source chip?
- Should agent runs created from UI actions be tagged for future history/change-set views?
- **Session & concurrency model** — elaborated in its own section below; it blocks the
  provider API.
- Where should intent/context assembly live? Today it is split — `buildRowPrompt` is
  client-side, `getErrorPrompt` / `service_context` are server-side. A frontend-only
  `buildAgentIntent` would duplicate logic the MCP surface also needs; a shared/server module
  both consume avoids drift.

## Recommended MVP

Build the shared agent controller/provider (lifting `useAgentChat` out of `agent-dock.tsx`
to the app root so features can call `sendToAgent`/`stageAgentDraft`), standardize the spark
glyph, and apply the pattern to three places:

1. DB row: single `Ask AI` spark, auto-send (copy → secondary menu).
2. Error Inbox: single `Ask AI` button, auto-send (copy → secondary menu).
3. Add Service: `AI discover from folder` → dock inspects in draft mode → prefilled Add
   Service form the user confirms (no agent-side config write).

This gives a clear product story: NoMoreIDE objects can become agent tasks, and the bottom dock is the native AI execution surface.
