# Home — a composable dashboard

**Status:** **stage 1 is built** — Home owns `/`, Services moved to `/services`, and six widgets render over the existing dashboard payload. §8's decisions all held except where §7.1 records what building it changed. Stages 2 and 3 are unstarted and deliberately so.
**Goal:** give the workbench a page that answers *"what is happening right now"* without visiting fourteen others — and leave a widget seam that a downloaded plugin can later fill, the way `/api/extensions` already fills the nav.

---

## 1. The problem, stated honestly

There are **14 nav destinations across 5 sections**, and not one of them is about the *present*. To learn that a service died, CI went red, and an error landed, you visit Services, GitHub, and Errors. Every page is a good page about its own domain; nothing is about the last ten minutes.

That is the argument for this page. **It is not customization.** Customization is a consequence — once you accept that different people care about different domains, a fixed layout has to be a compromise, and letting people drop the panels they never read is cheaper than guessing. But the value is the summary, and the summary is worth building even if the layout is never customizable at all.

Which is why §7 stages it in that order.

## 2. The name is already taken

`GET /api/dashboard` exists and means *the whole app-state payload* — config, runtime services, ports, health, timeline, git. It is what the shell polls and what `data` is in `app.tsx`.

So the page is **Home**, not Dashboard. Reusing the word would make `/api/dashboard` permanently ambiguous — a route that sounds like it serves one page while actually serving all of them. `Home` also says the true thing about the page: it is where you land.

## 3. What already exists, and why that decides the build order

Most of the first widgets need **no new endpoints at all**. `buildDashboardPayload` already returns:

| Field | The widget it feeds |
| --- | --- |
| `runtime.services` | Services — running / failed / stopped counts, click through to `/services` |
| `ports` | Port conflicts — the `occupied` entries are the only interesting ones |
| `health` | Health — the services failing a probe |
| `timeline` | Activity — the last N events |
| `git` | Repository — branch, dirty count, selected repo |
| `logs` | Recent output, tail of the first service |

Six widgets, zero backend work, from a payload the shell holds in memory already. That is the whole case for shipping a fixed layout first: **stage 1 is almost entirely a rendering exercise**, and it delivers the actual value. Everything expensive — persistence, add/remove, drag — is stage 2 and 3, and can be judged against a page that already earns its place.

Widgets that *do* need a fetch (errors, CI runs, deployments, agent tasks, docker, ssh hosts, metrics) each have a route module already: `errors-routes.ts`, `github-routes.ts`, `provider-routes.ts`, `agent-routes.ts`, `docker-routes.ts`, `ssh-server-routes.ts`, `metrics-routes.ts`. None needs a new core module — at most a narrower summary endpoint if a widget would otherwise pull a page's worth of JSON.

## 4. The relationship to the overview grids

There is already a cross-cutting view in the app, and missing it would mean building a third one.

When `projectScope === "all"`, a repo-scoped page stops showing one repo and renders a **grid of every registered project** for that domain — `buildProjectOverview(domain)` in `core/project-overview.ts`, with `OverviewDomain = "git" | "github" | "vercel"`.

That is **one domain × many projects**. Home is the **transpose**: **one project × many domains**. Same data, rotated. So:

- Home does not reimplement per-project summaries; a repo-scoped widget renders the same `ProjectGitSummary` / `ProjectGitHubSummary` the grid already builds.
- And Home gets a defensible answer to "what happens under the all-projects scope": **repo-scoped widgets switch to their grid form**, because that is exactly what every other page already does under that scope. No new concept, no third rule to learn.

## 5. The widget contract

The one thing that must be right on day one, because it is the thing that is expensive to change later.

A widget is **declared by the feature that owns it**, not listed in a Home file:

```
src/web/client/src/features/<feature>/widget.tsx   →  export const <feature>Widget: WidgetDefinition
src/web/client/src/features/home/widget-registry.ts →  imports and concatenates them
```

Exactly the shape `mcp/tools/index.ts` and `web/routes/index.ts` already have: a pure aggregator, never a per-item branch. Adding a widget means adding a file to a feature and one line to the registry.

```ts
// src/web/client/src/features/home/widget-types.ts

export interface WidgetDefinition {
  /** Stable across renames — this is what a saved layout stores. */
  id: string;
  titleKey: TranslationKey;
  icon: ReactNode;

  /** Columns out of 12. `min` is what the grid may not shrink past. */
  span: { default: number; min: number };

  /**
   * Whether the widget follows the repository picker. Repo-scoped widgets
   * render their all-projects grid form when `projectScope === "all"`,
   * matching what their page already does.
   */
  scope: "global" | "repo";

  /** The page it summarises; the whole card opens it. */
  page: AppPage;

  render(props: WidgetRenderProps): ReactNode;
}
```

Two changes the build made to this sketch, both recorded rather than quietly absorbed:

- **`page: AppPage`, not `href: string`.** A closed union is checked; a string is not, and every widget's destination is a page the client already knows.
- **No `source` discriminant yet.** Stage 1's six widgets all read the dashboard payload, so a union with one inhabited variant would be decoration. It arrives with the first `fetch` widget in stage 2, which is when it starts distinguishing anything.

**The hard rule, and the one most likely to be broken later: a widget is a read-only summary with at most one action.** Everything else is a click through to the real page. A widget that grows a second control has become a second implementation of its page, and the two will drift — this is the failure mode that kills dashboards, and it always arrives one reasonable-seeming button at a time.

Practically that means a widget stays inside the ~300-line file budget without effort. If one doesn't, it is doing too much.

## 6. Bento, and what "reliable" costs

Free-form bento — artful heterogeneous tiles — looks superb when a designer places every tile, and degrades the moment a *user* places them, which is the entire premise here. Two tiles the user shrank, one they moved, and the page reads as broken rather than composed.

What stays reliable under user control is a **12-column grid where widgets declare `span.default` and `span.min` and the grid packs them**, with fixed row heights per widget size class. It reads as bento when the spans vary — which they will, since a services summary wants 4 columns and a timeline wants 8 — but it cannot be made ugly, and it collapses to one column on a narrow window without any per-widget responsive logic.

Drag-to-reorder is a reordering of a list, not free 2D placement. That keeps the persisted layout a `string[]` plus per-widget span overrides, which is a schema that can survive a widget being renamed or removed.

**Amended by §7.9.** The list became `string[][]` — rows of ids — for a reason this section did not foresee: a packed list *cannot* guarantee a full row, so it leaves gaps at the end of short rows, and a gap is the one thing "it cannot be made ugly" was promising. Rows are still not free 2D placement: a widget belongs to a row and a position in it, there are no coordinates and no overlaps, and the schema still survives a widget being renamed or removed.

**Amended again by §7.10.** "Fixed row heights per widget size class" is gone twice over: a height is per-widget and optional, and rows no longer have a height at all. The grid itself is gone with them — a grid row is as tall as its tallest cell, which is the vertical version of exactly the gap §7.9 closed horizontally, and the only way out of it is to place every panel by hand. The schema did not change: `rows`, `spans`, `heights`, still v4.

## 7. Stages

**Stage 1 — a fixed Home. Built.** `/` is Home; Services is `/services`. Six widgets over the existing payload (§3). No persistence, no editing, no drag. This is the stage that has to justify the page; if a fixed Home isn't obviously better than landing on Services, stop here and delete it.

### 7.1 What building it changed

- **Home leads the `run` section rather than standing above the sections.** A section of its own would render a `HOME ─────` rule over a single row named Home, and hoisting it out would put a special case in the nav's render loop — the exact thing that loop exists not to have. Revisit if a second section-less row ever appears.
- **The embedded marketing demo still opens on Services.** It mounts with `syncLocation={false}`, so it never routed through `/`; what the site leads with is a marketing decision, not a consequence of this change.
- **One bug the fixed layout found immediately, which is the argument for stage 1 in miniature.** Health counted `unknown` as "not failing", so nineteen *stopped* services with nothing probed rendered as **"All healthy"** — a confident lie, on the page meant to be glanced at. Unknowns are now excluded from the denominator and a card with nothing known says so. No unit test would have caught it; looking at the real page did, in about four seconds.

### 7.2 The second pass: it was built as cards, and it was too thin

Stage 1 shipped wrong on both of the axes it is judged on, and both were obvious
on sight rather than in review.

- **It broke the layout law.** Every widget was a `rounded-lg border bg-card`
  tile — literally the "No" example in `DESIGN.md`, and the first item on its
  own before-you-ship checklist. It also led with a `text-2xl` figure, in a
  document that caps a normal view at 13px. Widgets are now grid cells divided
  by hairlines, with the counters split by `divide-x` the way that file already
  prescribes for counters. Nothing on Home draws a box.
- **One big number is not a summary.** "3" over "of 22 registered" tells you
  something is wrong but never *what*, so every panel still cost you a click —
  which makes the widget a worse version of the nav row above it. Each widget
  now leads with a strip of three or four counters and then **names things**:
  which service exited and with what code, which port is held and by whom, which
  files changed, which check is slow. Same payload, no new endpoints; the
  information was always in `data` and the panel was just refusing to print it.
- **Two things only real data showed.** Activity printed the service name twice
  a row, because timeline titles are written for a page that has no service
  column. And Health bailed to a bare sentence when nothing was probed, leaving
  the one panel on the page with no numbers on it — when "19 unprobed" was the
  useful fact. Both were invisible in an empty fixture and obvious in the app.

The generalisation, for stage 2: **a widget's job is to name, not to count.** A
picker that lets a user add more panels is only worth building if each panel
already earns its space, and a panel that shows a single figure does not.

### 7.3 The third pass: too much text, and the first widget that fetches

Two more corrections, both from looking at the built page rather than the plan.

- **The labels came off.** Six widgets with three or four labelled counters each
  put eighteen uppercase words on a page whose entire job is to be glanced at,
  and those words were identical on every refresh while the numbers were the
  part that changed. `WidgetStat` now draws the figure alone; the label survives
  as `title=` and an `sr-only` span. That only works because **tone is a
  property of the slot, never of the value** — the "failing" counter is red at 0
  as well as at 3, and zeros are dimmed so the one number that isn't zero is the
  one you see. A `tone={x > 0 ? "bad" : "idle"}` anywhere on this page would
  make an all-clear strip colourless and take the meaning with it.
- **Home had nothing to say about the agent half of the product.** A dashboard
  for an AI-native workbench that reports only processes, ports and files is
  describing the old half of itself. The Agent widget reports MCP connectivity
  and recent tool calls, and it lists only the servers that are *not* simply
  working — the count above already says the rest are fine, and four arbitrary
  healthy names plus "+10 more" is the exact filler this pass was removing.

**What the first fetch-backed widget cost, which stage 2 needs to know.** Agent
owns its own request (the `source` discriminant on the contract), and getting it
wrong froze the whole page:

- **A fetching widget has a state the others don't: not asked yet.** Rendering
  `0` there is not a placeholder, it is a wrong answer in the same typeface as a
  right one — "0 MCP servers connected" is alarming *and* untrue while the
  request is in flight. `WidgetStat` grew `pending`, which draws a dash.
- **Poll interval is a load-bearing number, not a default.** `mcp-status` is not
  a read: it shells out to `claude mcp list`, which cold-starts every configured
  server to health-check it — about six seconds here — and `core/mcp-auth.ts`
  caches for only 15s, so *any* interval slower than that pays the full cost
  every time. At the 20s this widget was written with, Home held an open
  connection to the daemon about a third of the time it was on screen. Chrome
  allows **six per host**, the dashboard already spends several on its event
  streams, and once that pool is exhausted every request from the page hangs
  indefinitely — the page stops updating and the widget sits on zeros forever.
  It is now 5 minutes, and the agent name (a 87KB `/api/agent` response read for
  one field) is resolved once per mount instead of once per poll.
- **The general rule for stage 2:** the picker cannot let a user add fetch-backed
  widgets without a budget. Six sockets is the whole allowance for the origin,
  and the streams the shell already holds are most of it. A widget that polls
  something expensive is not just slow — it takes the page down with it.

### 7.4 Snapshots and Databases, and what "expensive" actually means

The obvious reading of §7.3 — *fetch-backed widgets are dangerous* — is the
wrong one, and Snapshots and Databases were added to make the right one
explicit. Measured against a live daemon:

| Endpoint | Time | What it does |
| --- | --- | --- |
| `/api/databases` | 2 ms | reads config, masks passwords |
| `/api/snapshots` | 14 ms | one `git for-each-ref` |
| `/api/agent/mcp-status` | 6 000 ms | spawns `claude mcp list`, which cold-starts every server |

Three orders of magnitude. The hazard was never the fetch, it was the
**subprocess**: the question to ask of a candidate widget is what its endpoint
*does*, not whether it has one. Endpoints that read config or a git ref can poll
on a normal cadence; endpoints that spawn a CLI, or cross the network, cannot.
That rules out GitHub CI and deployments as widgets for now (0.5–1.5 s and rate
limited), and it makes the cheapest widgets of all the ones that need no request
at all — the shell already holds `useWorkflowTriggers()` as an app-wide context
and an open error stream, and a widget over either costs nothing.

Two things the widgets themselves settled:

- **Snapshots earns its place by answering a question you have *before* you
  work, not after:** is there a restore point, and how old is it. The counters
  split "today" from "kept" for exactly that reason — 30 snapshots where the
  newest is two days old is a different situation from 30 where the newest is
  from this session, and a single total cannot tell them apart.
- **Databases is a warning, not an inventory.** Registered connections are
  config: they do not change, so they are not news, and a panel that counted
  them would be the §7.2 failure again. `writeUnlocked` *is* news — every write
  in `core/db-write.ts` is gated on it, so an unlocked connection is a loaded gun
  left on the table. The panel leads with that count, puts unlocked connections
  first, and names the rest dimmed underneath.

### 7.5 Conversations, and the two things the owner asked for

The ask was *"AI section — can we have a logo for what we have, and a short list
of history conversations that can resume?"* Two requests, and they got different
answers.

**The list, yes.** `/api/terminal/transcripts` is 90ms and 8.7KB for this
repository — the §7.4 test again, since it reads the providers' own session
files and spawns nothing. The panel leads with how many conversations were
touched today against how many can be resumed at all, then names the newest
five.

Three things it settled:

- **The widget advertises; the page resumes.** A panel is a single `<button>`,
  so a per-row resume control is not merely awkward, it is invalid markup and
  unreachable by keyboard. Rather than work around that, the widget takes it as
  the boundary: the rail on the Agent page already resumes properly, and a
  second implementation on Home would drift from it.
- **`scope=all` was tempting and wrong.** It answers with every project on the
  machine — 200 conversations and 72KB here, against 20 and 8.7KB scoped — and
  the panel draws five rows either way. That is §7.3's 87KB-for-one-field
  mistake wearing a different hat. It is also the worse answer: what you were
  doing *in this repository* is what you are about to pick up.
- **Full width, for the only prose on the page.** Every other panel holds
  counters and identifiers that fit in half a row. A conversation title is a
  typed sentence — real ones here run to the 200-character cap — so the columns
  it does not need are the ones the title spends. It keeps the packing honest
  too: a seventh 6-span would have left the page's first ragged row.

**The logos, mostly no.** `features/deploy/provider-logo.tsx` already sets the
policy: a lucide glyph unless the mark is unmistakable at 14px, because a
half-remembered logo redrawn from memory looks worse than an honest generic one.
The fourteen MCP servers on the Agent widget are Gmail, Canva, Notion,
Cloudflare and friends, and hand-rolling fourteen third-party brand SVGs is the
exact thing that rule exists to prevent — those marks belong in the extension
manifest, once it carries assets. Claude and Codex are the exception the rule
allows for, and they are already in the tree: `features/agent/agent-logos.tsx`
has both, sourced and colour-correct, so the resume rows carry the real mark.
That is what added `mark` to `WidgetRow` — a conversation is not healthy or
failing, so the status dot had nothing to say about it.

**Stage 2 — add and remove. Built.** An edit mode with a widget picker, and layout persisted (§8). Adding fetch-backed widgets — errors, CI, deployments, agent tasks — is part of this stage, since "add as many as you want" is only meaningful once there are more widgets than fit.

### 7.6 Stage 2, and the widths that triggered it

Stage 1's kill criterion (§10) was "the honest reaction is *I still go straight
to Services*". The actual reaction was the opposite and it arrived as a
complaint about width: on a 3400px window the Conversations panel was mostly
empty, because `core/agent-transcripts.ts` caps a title at 200 characters and no
amount of column gets a 200-character sentence past about 900px. The fix for
that one panel is a narrower default. The fix for the *class* of problem is that
nobody's window is the window this was tuned on, which is stage 2.

What it settled:

- **The saved layout is nullable, and `null` is not `[]`.** `null` means "never
  customised", so Home follows the registry and a widget shipped later simply
  appears. `[]` means "I removed everything", which is a choice to honour rather
  than silently overrule — the page shows its empty state and keeps the picker
  and Reset in reach (§8.4). Reset writes `null`, not a copy of the default, so
  a reset install starts tracking the registry again.
- **The registry became a default rather than the layout.** It is still the only
  place a widget is declared; `home-layout.ts` resolves a saved list against it
  and drops ids it no longer knows, silently (§8.5).
- **Arrows, not drag.** §6 already argued the persisted shape is a list, and a
  list has exactly one move: one place earlier or later. Two chevrons are the
  whole of it — no pointer capture, no drop targets, no separate keyboard path
  bolted on afterwards for the same operation. Drag can come in stage 3 if
  anyone misses it.
- **Edit mode swaps the element, not the layout.** A panel is a `<button>`;
  controls cannot nest inside one. So editing renders the same cell as a `<div>`
  carrying the controls. The cost is that a `fetch` widget remounts once on each
  toggle, which is the right thing to pay for a mode you are in for ten seconds.
- **The controls are the column count, not S/M/L.** The grid is twelve columns
  and the number is the entire fact; a size name would be a second vocabulary
  for a thing that already had one. **This was wrong, and it lasted one
  conversation** — see §7.7.
- **The strip at the foot of the page, not a toolbar at the head.** Home is
  full-bleed by design and the rarest action on the page should not be the first
  thing on it. The scope note was already down there.

### 7.7 `4 6 12` lasted exactly one reader

The first thing the owner said on seeing the size control was *"what does 4, 6,
12 mean"*, and the second was *"can it be more flexible — resize by dragging the
edge with the cursor"*. Both are the same verdict on the argument above: a
number is only "the entire fact" to someone who already knows the grid is
twelve columns wide, and a control that has to be explained has failed before
anyone has read the explanation.

So the three buttons became **the panel's right edge, draggable**. What it fixed
is not discoverability alone:

- **A width is a place, not a quantity.** Setting one by picking from a legend
  means converting "about this wide" into a number and back. Dragging the edge
  skips both conversions — the control *is* the thing being set, and the answer
  is visible while you are still deciding it.
- **Presets were a false economy.** Three buttons existed because `WidgetSpan`
  was `4 | 6 | 12`, which was itself only ever an artefact of Tailwind needing
  literal class names. Writing out all ten literals costs ten lines and buys
  every width between a quarter row and the whole one, which is what makes a
  drag feel continuous rather than magnetic.
- **The grid is the ruler.** One twelfth of `[data-widget-grid]`, measured at
  pointer-down so a mid-drag reflow cannot move the origin under the cursor.
- **Drags end where they like.** The listeners live on the window, not behind
  `setPointerCapture` — a capture the browser refuses would otherwise strand a
  panel mid-resize with no way to release it. (Verified the hard way: the
  browser-automation harness in this session could not synthesise drags at all,
  which is exactly the class of environment that breaks a capture-only handler.)
- **Arrow keys still resize.** A drag handle that answers only to a mouse is a
  setting some users of this page simply do not have.

### 7.8 The drag was half a resize, and it moved the page while you aimed

The dragged edge shipped and the owner's verdict was *"the result is not good"*,
with two specifics: it should **drag with a frame, the way the agent dock's
splitter does**, and it resizes **one axis when it should do both at once**.
Both are about the same thing — the gesture did not behave the way a resize
behaves anywhere else.

- **Nothing reflows until you let go.** The old drag re-laid the grid on every
  pointer move, so widening a panel pushed its neighbours onto other rows and
  changed the page you were looking at *while you were aiming at it*. What moves
  now is a dashed frame over an untouched page (`WidgetResizeFrame`), which is
  what the dock's splitter does and what every window manager does. It is drawn
  `fixed`, because the grid clips its own overflow and a frame for a panel
  dragged to full width has to be allowed past that. It appears on pointer-down
  at the panel's *true* rect, not the nearest snap — a frame that jumped 8px
  before you moved would read as the resize having already happened.
- **One corner, no edges.** The pass that added the corner kept both edges, and
  the owner's next question was whether the width edge was still needed — it is
  not. The corner does everything the edges did, and three targets on every
  panel is a control surface where there should be a page. Losing them costs one
  thing, which the corner has to buy back: an edge could only move one axis, so
  it could not accidentally set the other. Hence **only the axis that actually
  moved is written** — a drag straight sideways lands on the height it started
  at and stores nothing, leaving the panel free to keep fitting its content.
  Both axes in one gesture are still **one write**; committing them separately
  would leave a frame where the panel is its new width at its old height, and
  two entries of history for one gesture.
- **Height is not a column, so it needs its own ruler.** Columns are a fraction
  of the window; rows cannot be, because Home scrolls and there is no page
  height to divide. A height is therefore a count of fixed 32px units
  (`HOME_ROW_PX`), which is what makes two panels dragged to "4" actually line
  up.
- **`null` height is fit-to-content, and stays the default.** How tall a summary
  needs to be is a fact about what it is currently summarising, not a decision
  anyone should have to make up front — so a widget declares a width and *not* a
  height, a stored layout from before this pass keeps fitting its content, and
  double-clicking a height grip gives the panel back to its content the way the
  dock's grip does.
- **A height sizes the body, not the cell — so a height is one panel's, not the
  row's.** The first cut drew the panel's bottom rule on the grid cell, which
  stretches; a taller widget therefore dragged every panel beside it down, and
  the owner's verdict was immediate: *make only itself change, so in a row the
  sizes can differ*. He is right, and the fix is a split. The cell keeps
  stretching and keeps the **column** rules, which must run the full height of
  the row or the page loses its structure. The padded body inside it owns the
  height, the clipping, the resize grip, and the **line under the panel** —
  because that line is not a property of the row: a panel four units tall beside
  one of eight has to end at four, or the tallest widget is deciding for
  everyone.
- **The space below a short panel is empty, and that is the honest picture.**
  Bounded by the column rules, with no line across it. The row is still as tall
  as its tallest member — the only way it could not be is masonry, which CSS
  grid does not have anywhere it can be relied on, and which would cost more
  than the whitespace does. Clipping stays: asking for less room than the
  content takes is a legitimate thing to mean, and a height that silently
  refused to shrink would be the resize that "does nothing" all over again.

### 7.9 The gap at the end of the row, and the drag that fixes both

Two more findings from the same reviewer, one screenshot apart: *"when I shrink
the left, the right moves left and then it's empty on the right — we never want
empty"*, and *"can we drag a panel to a new place?"*. They look unrelated. They
are the same finding: **the page was a flow, and a flow has no places in it.**

A flow wraps wherever the next widget stops fitting. Shrink a panel and the
leftover columns are only usable if the next widget happens to want that many or
fewer — otherwise it wraps, and the leftover is dead space nobody chose. And in
a flow there is nowhere to *drop* something: a widget's position is an index in
a list, so the only honest gesture is "one place earlier", which is what the
chevrons were.

So rows became a stored thing: `HomeLayout.rows: string[][]`, `UiPreferences`
v4, migrated from v3 by packing the flat list exactly the way the flow was
drawing it.

- **A row always fills the grid**, and that is an invariant rather than a
  cleanup pass. `fitRow` restores it after anything that can disturb it —
  resizing, removing, dropping, or the registry retiring a widget out from under
  a saved layout — by handing columns to the row's narrowest panel and taking
  them from its widest, so proportions survive: `[4, 4]` fills as `[6, 6]`, not
  `[8, 4]`. A gap is now unrepresentable.
- **A resize is a splitter.** Columns have to come from somewhere, and the row
  is where: neighbours give up columns nearest-first, never below `MIN_SPAN`.
  That also caps the drag — a panel in a row of two can reach nine columns, not
  twelve — and the frame is computed through the same function that will do the
  commit (`previewSpan`), so it cannot promise a width the row will refuse.
- **A drop has a place to mean.** Between two panels in a row, or between rows
  for a row of its own. The indicator is a line where the panel will land, drawn
  over a page that has not moved — same rule as the resize frame, for the same
  reason. Four panels is the most a row can hold and stay legible, so a fifth
  drop is refused by not drawing an indicator rather than by undoing itself
  afterwards.
- **The chevrons stay.** They are the same operation from the keyboard, and they
  now walk the page in reading order — off the end of a row they step into the
  next one, because that is what "later" means once there are rows.

**Stage 3 — drag to reorder.** Now shipped, as above. What is still deliberately
absent is free 2D placement: no coordinates, no overlaps, no empty cells to drag
into. A row of panels is the largest amount of layout freedom that cannot be
made to look broken.

**Stage 4 — nothing yet.** The kill criterion in §10 still applies: the next
thing to build here is whatever the page turns out not to answer, not the next
layout affordance. Resize landed early, back in stage 2, because the complaint
that started it was a width — shipping "you can remove it" as the answer to "it
is the wrong shape" would have missed the point.

**Not staged, deliberately:** widgets contributed by *downloaded* plugins. That is blocked by the same thing the Extensions market is blocked by — runtime-loading third-party React — and the widget registry should be shaped so it becomes possible, not built as though it already is.

### 7.10 The gap moved from the end of the row to the bottom of it

§7.9 made a gap unrepresentable *horizontally*: a row always fills twelve
columns. It left the vertical one untouched, and the owner found it in the next
screenshot. **A grid row is as tall as its tallest cell**, so a short panel
beside a tall one held empty space open underneath itself for the height of its
neighbour, and the next row started below the tallest member rather than below
the short one.

That is not a bug in the layout, it is what a row *is*, and it is why closing it
meant leaving CSS grid. The owner was told the cost before any of this was
written — masonry cannot be expressed in grid, so every panel is absolutely
positioned and the layout is computed in JS — and asked for it anyway.

**The rows survive; only `y` moved.** A row still authors reading order,
left-to-right position and width, still fills the grid, and is still what a drop
and a splitter resize operate on. Everything §7.9 guarantees is guaranteed the
same way. What a row no longer decides is how far down its panels start.

- **The placement rule is a skyline** (`home-pack.ts`). Each panel, in reading
  order, drops until it lands on the lowest thing already occupying any column
  it covers. A wide panel is therefore held up by whichever narrow neighbour ran
  longest, and can never overlap anything — panels are disjoint by construction,
  not by luck.
- **Only `top` is measured.** `left` and `width` are percentages of the grid
  derived from the column count alone, so a window resize stays pixel-exact
  without remeasuring and the horizontal layout is never wrong between passes.
- **A panel with no stored height is still as tall as what it holds**, which is
  the default and the reason this needs measuring at all: only the DOM knows that
  number. Measurement runs in `useLayoutEffect`, so the settling pass exists but
  is never painted, and a signature guard makes termination a guarantee rather
  than an argument — placing a panel changes where it is, never how tall it is.
- **Rows stopped being elements**, so the move drag had to change with them
  (`home-move.tsx`). Row bands now overlap — a row's members can end at very
  different depths — so "which row is the cursor in" no longer has one answer.
  The drag hit-tests *panels*, which never overlap, and asks whichever one it
  lands on which row it belongs to. That also aims better: "the left half of this
  one" is what a person dropping a panel beside another one means.

**The line became a frame.** §7.9 drew the drop as a line between two panels,
which answers "where in the order" — and where in the order is not what anyone
is deciding. They are deciding what the page will look like, and masonry pulled
those two questions apart: a drop re-shares the target row's columns *and* drops
the panel wherever the skyline puts it, so one position in the order can mean
very different rectangles. Dragging a full-width panel into a row of two makes it
a third as wide, and the line said nothing about that.

So the drag draws the rectangle instead, in the same dashed frame the resize
gesture uses — the two make the same promise and should not look like two kinds
of answer. It is not an approximation: `previewPlacement` runs the real
`moveWidget` against a copy of the layout and packs the result, which is the
bargain `previewSpan` already made for the resize frame. That is only affordable
because §7.10 made placement a pure function; under CSS grid there was nothing
to ask but the browser, and only after committing. One approximation survives,
in the height — a fit-to-content panel landing in a narrower slot will wrap more
than the frame showed, and re-measuring it at a width it does not have yet would
mean rendering it twice per pointermove.

**What this costs, stated plainly.** The dead space did not vanish, it moved: a
page whose columns run to different depths is ragged at the bottom, and that
raggedness is the feature — it is the same slack, collected in one place instead
of scattered under every short panel. And the model and the picture can now
disagree about order: a panel in row 3 may sit visibly higher than one in row 2,
because it rose into a gap. Reading order still governs the chevrons, the drop
indices and the packing; it is simply no longer a top-to-bottom scan of the page.

**Still not free 2D placement.** No coordinates, no overlaps, no empty cells to
drag into — the amendment §7.9 made to §6 stands. A panel belongs to a row and a
position in it; the only thing computed is how far it falls.

## 8. Decisions needed before stage 1

**8.1 Where the layout lives — `UiPreferences` v3, not ConfigStore.**

I argued for ConfigStore before reading the store. The precedent is against me and it is unanimous: every view preference — theme, language, density, `sidebarDocked`, `extensionsExpanded`, `agentDockPlacement`, `projectScope`, accents — lives in `UiPreferences` in `localStorage`, versioned at `2` with a migration that accepts `1`. And `projectAccents: Record<string, AccentChoice>` proves the store already carries a dynamic, nested structure.

Putting layout in ConfigStore would mean a Zod schema, a daemon round-trip on every toggle, and a preference that behaves unlike every other preference. The honest cost of `localStorage` is that layout doesn't follow you to another browser or into the Tauri app — which is already true of your theme, and nobody has asked for that to change.

So: `version: 3`, add `home: { widgets: string[]; spans: Record<string, number> }`, and the existing migration hands v1/v2 installs the default layout.

Rows (§7.9) later made it **v4**: `home: { rows: string[][]; spans; heights }`, with v3's flat list packed into rows on read — one migration, in the parser, so the layout a user had is the layout they get back. That bump was unavoidable in a way the one below was not: the shape of the field changed, and no reading of a `string[]` gives you rows.

Heights (§7.8) arrived earlier as `heights?: Record<string, number>` and pointedly **did not bump the version**: the field is optional and its absence is not a missing value but a real state — "no height at all, fit the content" — which is exactly what a v3 layout stored before it existed should mean. A version bump would have been a migration inventing an answer nobody gave — and, until v4, every bump also cost a matching `version === n` in `lib/theme.ts`, which reads this document pre-mount and flashed the wrong theme whenever someone forgot. That list is gone: the pre-mount read now accepts any version, because it reads one field that has meant the same thing since v1 and the real parser is what decides whether a document is usable.

*As built:* `home` is `HomeLayout | null`, and v1/v2 installs migrate to `null` rather than to a stored copy of the default — see §7.6 for why the distinction is load-bearing. `lib/theme.ts` reads the same document before React mounts and had to learn `3` alongside `1` and `2`, or every customised install would have flashed the wrong theme on load.

**8.2 `/` becomes Home; Services becomes `/services`.**

Contained and test-guarded: `PAGE_PATHS` in `app.tsx`, `shellPaths` in `shell-routes.ts`, and `test/shell-paths.test.ts` already asserts parity between them, so getting it half-done fails CI rather than 404ing on refresh.

Worth being explicit that this is **not optional**. A Home page that is a 15th nav row is a page nobody visits, and it makes the sidebar-overflow problem worse rather than better — 14 rows plus 4 children already overflow a laptop viewport.

**8.3 Scope.** Home is global. Repo-scoped widgets follow the existing repo picker and say which repo they are showing; under `projectScope: "all"` they render their grid form (§4).

**8.4 Empty state.** Stage 2 lets a user remove every widget. The page then needs to be recoverable without clearing `localStorage` — a "reset to default layout" action in the edit mode, not just an empty canvas.

**8.5 Unknown widget ids.** A saved layout naming a widget that no longer exists must be dropped silently on read, not rendered as an error. This is the same problem the extension registry has with a stored provider id, and it should fail the same quiet way.

## 9. Costs this incurs elsewhere

- **`website/src/mock-api.ts`** — any widget on a `fetch` source adds an endpoint the embedded demo reads *on mount*. Without a matching mock handler the seam hands the widget `undefined` and the marketing site's embedded dashboard white-screens. Stage 1 adds none of these; stage 2 adds several.
- **i18n** — `en.ts` is the source of truth and `zh.ts` is a `Partial`, so a missing zh key renders English silently rather than failing the build. Both sides in the same change, as always.
- **Polling** — stage 1 costs nothing, since it reads a payload already being polled. Every stage-2 widget is a new interval; the registry should make polling a property of the definition rather than something each widget invents, or a full page of widgets becomes a request storm.

## 10. What would make me abandon this

Written down now, while it is still cheap to stop:

- Stage 1 ships and the honest reaction is "I still go straight to Services." Then the summary wasn't the missing thing, and stages 2–3 would be building a preference system on top of a page nobody wants.
- The first three widgets each need a bespoke endpoint. That would mean the existing payload is the wrong shape for summarising, and the real work is a summary API, not a page.
