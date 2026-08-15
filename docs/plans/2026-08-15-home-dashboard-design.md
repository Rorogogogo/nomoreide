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

**Stage 2 — add and remove.** An edit mode with a widget picker, and layout persisted (§8). Adding fetch-backed widgets — errors, CI, deployments, agent tasks — is part of this stage, since "add as many as you want" is only meaningful once there are more widgets than fit.

**Stage 3 — reorder and resize.** Drag to reorder; a size control per widget bounded by `span.min`. Only if stage 2 shows people actually want it — a picker that lets you drop what you don't read may well be the whole of the demand.

**Not staged, deliberately:** widgets contributed by *downloaded* plugins. That is blocked by the same thing the Extensions market is blocked by — runtime-loading third-party React — and the widget registry should be shaped so it becomes possible, not built as though it already is.

## 8. Decisions needed before stage 1

**8.1 Where the layout lives — `UiPreferences` v3, not ConfigStore.**

I argued for ConfigStore before reading the store. The precedent is against me and it is unanimous: every view preference — theme, language, density, `sidebarDocked`, `extensionsExpanded`, `agentDockPlacement`, `projectScope`, accents — lives in `UiPreferences` in `localStorage`, versioned at `2` with a migration that accepts `1`. And `projectAccents: Record<string, AccentChoice>` proves the store already carries a dynamic, nested structure.

Putting layout in ConfigStore would mean a Zod schema, a daemon round-trip on every toggle, and a preference that behaves unlike every other preference. The honest cost of `localStorage` is that layout doesn't follow you to another browser or into the Tauri app — which is already true of your theme, and nobody has asked for that to change.

So: `version: 3`, add `home: { widgets: string[]; spans: Record<string, number> }`, and the existing migration hands v1/v2 installs the default layout.

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
