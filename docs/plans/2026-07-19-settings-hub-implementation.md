# Settings Hub Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the small Settings page with a searchable, scoped settings hub whose first release contains only preferences with real product behavior.

**Architecture:** Keep synchronous visual preferences in a versioned local-storage document, persist machine-wide operational preferences through a new backend `AppSettingsStore`, and persist project preferences under an optional `preferences` key in `nomoreide.config.json`. A React settings provider merges these sources for the hub and existing feature consumers, while the API layer remains transport-neutral.

**Tech Stack:** TypeScript, React 19, Tailwind CSS 4, Zod, Node.js filesystem APIs, Vitest, happy-dom.

---

## Delivery scope

This plan implements the full hub shell and a deliberately practical first catalogue:

- General: language, sidebar docking, default project scope
- Appearance: light/dark/system theme, density, code font size, reduced motion
- Terminal: font size, cursor style, scrollback, copy on select, terminate confirmation
- Services & Logs: timestamps and line wrapping for the current project
- Git & GitHub: Claude co-author preference and GitHub connection status/management link
- Agents & MCP: preferred chat provider and navigation to Agent Environments
- Database & Safety: confirmation for writes and default result limit for the current project
- Notifications: browser permission/status only (no non-functional event toggles)
- Data & Privacy: storage locations, export, reset UI preferences
- About: current version, runtime URL, docs, release notes, issue reporting

Do not add auto-update installation, service restart policies, notification-event toggles, retention jobs, or default-branch mutation in this slice. Those need separate end-to-end behavior.

### Task 1: Create an isolated implementation worktree

**Files:**
- No source changes

**Step 1: Check the current branch and worktree state**

Run: `git status --short && git branch --show-current`

Expected: the current checkout may contain unrelated edits; record them and do not stage them.

**Step 2: Create the worktree**

Run: `git worktree add ../nomoreide-settings-hub -b feat/settings-hub`

Expected: a clean worktree at `../nomoreide-settings-hub` based on the commit containing this plan.

**Step 3: Verify isolation**

Run: `git -C ../nomoreide-settings-hub status --short`

Expected: no output.

### Task 2: Add the machine-wide operational settings store

**Files:**
- Create: `src/core/app-settings.ts`
- Create: `test/app-settings.test.ts`

**Step 1: Write failing store tests**

Cover these cases in `test/app-settings.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AppSettingsStore, DEFAULT_APP_SETTINGS } from "../src/core/app-settings.js";

describe("AppSettingsStore", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "nomoreide-settings-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("returns defaults when the file does not exist", async () => {
    await expect(new AppSettingsStore(join(dir, "settings.json")).load())
      .resolves.toEqual(DEFAULT_APP_SETTINGS);
  });

  test("merges a validated patch and persists it", async () => {
    const path = join(dir, "settings.json");
    const store = new AppSettingsStore(path);
    await store.update({ terminal: { fontSize: 16 } });
    await expect(store.load()).resolves.toMatchObject({ terminal: { fontSize: 16 } });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
  });

  test("rejects invalid terminal limits without changing the file", async () => {
    const path = join(dir, "settings.json");
    const store = new AppSettingsStore(path);
    await store.update({ terminal: { fontSize: 14 } });
    await expect(store.update({ terminal: { fontSize: 80 } })).rejects.toThrow();
    await expect(store.load()).resolves.toMatchObject({ terminal: { fontSize: 14 } });
  });

  test("reset restores defaults", async () => {
    const store = new AppSettingsStore(join(dir, "settings.json"));
    await store.update({ terminal: { copyOnSelect: true } });
    await expect(store.reset()).resolves.toEqual(DEFAULT_APP_SETTINGS);
  });
});
```

**Step 2: Run the test and verify failure**

Run: `npx vitest run test/app-settings.test.ts`

Expected: FAIL because `src/core/app-settings.ts` does not exist.

**Step 3: Implement the schema and store**

Create a Zod schema with this public shape:

```ts
export interface AppSettings {
  version: 1;
  terminal: {
    fontSize: number;
    cursorStyle: "block" | "underline" | "bar";
    scrollback: number;
    copyOnSelect: boolean;
    confirmTerminate: boolean;
  };
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 1,
  terminal: {
    fontSize: 13,
    cursorStyle: "block",
    scrollback: 5000,
    copyOnSelect: false,
    confirmTerminate: true,
  },
};
```

Validate `fontSize` as an integer from 10–24 and `scrollback` as an integer from 500–100000. `update()` must deep-merge the terminal patch into the confirmed document, validate the complete result, create the parent directory, write a sibling temporary file, and rename it over the destination. Export `defaultAppSettingsPath()` using `$XDG_CONFIG_HOME/nomoreide/settings.json` or `~/.config/nomoreide/settings.json`. Return structured clones so callers cannot mutate defaults.

**Step 4: Run the store tests**

Run: `npx vitest run test/app-settings.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/app-settings.ts test/app-settings.test.ts
git commit -m "feat: add versioned app settings store"
```

### Task 3: Add global and project settings APIs

**Files:**
- Create: `src/web/routes/settings-routes.ts`
- Modify: `src/web/routes/context.ts`
- Modify: `src/web/routes/index.ts`
- Modify: `src/web/server.ts`
- Modify: `src/core/config-store.ts`
- Modify: `src/core/types.ts`
- Modify: `test/web-server.test.ts`
- Modify: `test/config-store.test.ts`

**Step 1: Write failing config and HTTP tests**

Add config-store coverage proving that this optional project shape round-trips and defaults safely when absent:

```ts
preferences: {
  logs: { showTimestamps: false, wrapLines: false },
  database: { confirmWrites: true, resultLimit: 200 },
}
```

Add web-server tests for:

- `GET /api/settings` returns `{ ok: true, global, project }`.
- `PATCH /api/settings/global` updates only the provided terminal key.
- `PATCH /api/settings/project` updates only `config.preferences`.
- Invalid `fontSize` and `resultLimit` return 400 and do not persist.
- `POST /api/settings/global/reset` restores defaults.
- `POST /api/settings/project/reset` removes project preferences and exposes defaults.

Construct the server with a temporary `settingsPath`; add `settingsPath?: string` to `WebServerOptions` for this purpose.

**Step 2: Run focused tests and verify failure**

Run: `npx vitest run test/config-store.test.ts test/web-server.test.ts`

Expected: FAIL because the schema, route, and store service are missing.

**Step 3: Extend the project schema**

Add this shared type to `src/core/types.ts`:

```ts
export interface ProjectPreferences {
  logs: { showTimestamps: boolean; wrapLines: boolean };
  database: { confirmWrites: boolean; resultLimit: number };
}
```

Add `preferences?: ProjectPreferences` to `NoMoreIdeConfig`. In `config-store.ts`, define nested Zod schemas with defaults of `true` for timestamps, `true` for wrapping, `true` for write confirmation, and `100` for the result limit. Validate the limit as an integer from 10–5000. Export a `DEFAULT_PROJECT_PREFERENCES` constant and add `updatePreferences(patch)` plus `resetPreferences()` methods. Preserve every unrelated config key.

**Step 4: Register the operational settings service**

Instantiate `AppSettingsStore` in `createWebServer`, inject it as `appSettings` in `RouteServices`, and use `options.settingsPath ?? defaultAppSettingsPath()`.

**Step 5: Implement routes**

Use `requestJsonBody`, `sendJson`, and existing route error conventions. Route behavior:

```text
GET   /api/settings                 -> merged confirmed documents
PATCH /api/settings/global          -> AppSettingsStore.update(body)
PATCH /api/settings/project         -> ConfigStore.updatePreferences(body)
POST  /api/settings/global/reset    -> AppSettingsStore.reset()
POST  /api/settings/project/reset   -> ConfigStore.resetPreferences()
```

Respond with status 400 for Zod/config validation errors and status 500 for filesystem failures. Never return a partially updated document.

**Step 6: Run focused tests**

Run: `npx vitest run test/config-store.test.ts test/web-server.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/core/app-settings.ts src/core/config-store.ts src/core/types.ts src/web/routes/settings-routes.ts src/web/routes/context.ts src/web/routes/index.ts src/web/server.ts test/config-store.test.ts test/web-server.test.ts
git commit -m "feat: expose scoped settings APIs"
```

### Task 4: Add client settings models, API adapters, and provider

**Files:**
- Create: `src/web/client/src/lib/api/settings-api.ts`
- Create: `src/web/client/src/lib/api/settings-http.ts`
- Create: `src/web/client/src/lib/api/settings-tauri.ts`
- Create: `src/web/client/src/lib/api/settings.ts`
- Create: `src/web/client/src/features/settings/settings-context.tsx`
- Create: `src/web/client/src/features/settings/ui-preferences.ts`
- Modify: `src/web/client/src/lib/api/index.ts`
- Modify: `src/web/client/src/app.tsx`
- Create: `test/settings-context.test.tsx`

**Step 1: Write failing provider tests**

Using the repository's happy-dom `createRoot`/`act` pattern, verify:

- UI preferences migrate current `nomoreide-theme-choice`, `nomoreide-language`, `nomoreide:sidebar-docked`, and `nomoreide:project-scope` values.
- A safe optimistic global update changes context immediately and retains the server-confirmed result.
- A rejected update rolls back and exposes an error.
- Project updates never change global settings.
- Reset removes only the requested scope.

**Step 2: Run the test and verify failure**

Run: `npx vitest run test/settings-context.test.tsx`

Expected: FAIL because the modules do not exist.

**Step 3: Implement the API domain**

Define `SettingsSnapshot`, `GlobalSettingsPatch`, and `ProjectSettingsPatch` in `settings-api.ts`. Follow the repository's `*-api.ts`, `*-http.ts`, `*-tauri.ts`, and facade pattern. HTTP calls use the endpoints from Task 3. Until Rust commands exist, the Tauri adapter must use the HTTP adapter rather than returning fabricated defaults.

**Step 4: Implement versioned UI preferences**

Use one key, `nomoreide:ui-preferences`, with this shape:

```ts
export interface UiPreferences {
  version: 1;
  theme: "light" | "dark" | "system";
  language: Language;
  density: "comfortable" | "compact";
  codeFontSize: number;
  reducedMotion: boolean;
  sidebarDocked: boolean;
  projectScope: "all" | "project";
}
```

Defaults are system theme, English, comfortable density, 12px code text, system-derived reduced motion, undocked sidebar, and all-project scope. Migrate old keys once, validate parsed values, and preserve the old theme/language behavior while migration lands.

**Step 5: Implement `SettingsProvider`**

The provider must:

- Load the API snapshot once.
- Expose `loading`, `error`, `saveState`, confirmed global/project settings, and UI preferences.
- Optimistically update one scope at a time.
- Roll back failed saves and keep an actionable error string.
- Expose global/project reset and UI reset actions.
- Listen for UI changes and apply document attributes/CSS variables.

Wrap the existing application content with the provider. Move sidebar docking and project-scope persistence from ad hoc effects in `app.tsx` to provider values, while leaving navigation state in `App`.

**Step 6: Run provider tests**

Run: `npx vitest run test/settings-context.test.tsx test/default-theme.test.ts`

Expected: PASS, including preservation of the no-flash theme bootstrap.

**Step 7: Commit**

```bash
git add src/web/client/src/lib/api/settings-* src/web/client/src/lib/api/settings.ts src/web/client/src/lib/api/index.ts src/web/client/src/features/settings/settings-context.tsx src/web/client/src/features/settings/ui-preferences.ts src/web/client/src/app.tsx test/settings-context.test.tsx test/default-theme.test.ts
git commit -m "feat: add scoped settings client state"
```

### Task 5: Build the responsive settings hub shell

**Files:**
- Create: `src/web/client/src/features/settings/settings-layout.tsx`
- Create: `src/web/client/src/features/settings/setting-controls.tsx`
- Create: `src/web/client/src/features/settings/settings-catalogue.ts`
- Rewrite: `src/web/client/src/features/settings/settings-view.tsx`
- Modify: `src/web/client/src/app.tsx`
- Create: `test/settings-view.test.tsx`

**Step 1: Write failing UI tests**

Cover:

- All ten categories render in navigation.
- Selecting a category changes the main heading.
- Search finds settings by label, description, and category.
- Search results retain Global or Current project badges.
- Project categories are disabled with a reason when no project is selected.
- Keyboard arrow navigation moves between category buttons.
- Loading, load error/retry, saving, saved, and save-error states render.
- Narrow layout exposes a labelled category `<select>`.

Pass `activeProject` and navigation callbacks into `SettingsView` from `App`; do not have the settings page rediscover global app state.

**Step 2: Run the UI test and verify failure**

Run: `npx vitest run test/settings-view.test.tsx`

Expected: FAIL against the current three-section page.

**Step 3: Implement reusable controls**

Create accessible `SettingRow`, `SettingToggle`, `SettingSelect`, `SettingNumberInput`, `ScopeBadge`, `SaveStatus`, and `UnavailableSetting` primitives. Every input must have a real label and description; do not use placeholder text as a label.

**Step 4: Implement catalogue and navigation**

Keep category metadata and searchable keywords in `settings-catalogue.ts`. Use stable ids:

```ts
type SettingsCategoryId =
  | "general" | "appearance" | "terminal" | "services-logs"
  | "git-github" | "agents-mcp" | "database-safety"
  | "notifications" | "data-privacy" | "about";
```

The desktop sidebar is `w-56`; the content panel has a readable `max-w-3xl`. On widths below `md`, hide the sidebar and render the selector. Search switches the content region into grouped results without changing the selected category.

**Step 5: Populate only real controls**

Bind the catalogue listed in Delivery scope. When a category has no additional implemented control, use a management/status row or a concise “More controls will appear as capabilities become configurable” message, not a disabled fake toggle.

For mixed categories, group Global and Current project sections separately. Pass `activeProject={activeProject}` and callbacks for navigation to GitHub, Agent Environments, and Database from `App`.

**Step 6: Run UI tests**

Run: `npx vitest run test/settings-view.test.tsx`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/web/client/src/features/settings src/web/client/src/app.tsx test/settings-view.test.tsx
git commit -m "feat: build searchable settings hub"
```

### Task 6: Apply appearance preferences throughout the app

**Files:**
- Modify: `src/web/client/src/lib/theme.ts`
- Modify: `src/web/client/src/components/theme-toggle.tsx`
- Modify: `src/web/client/src/styles.css`
- Modify: `src/web/client/index.html`
- Modify: `test/default-theme.test.ts`
- Create: `test/ui-preferences.test.ts`

**Step 1: Write failing behavior tests**

Verify:

- System theme follows `matchMedia('(prefers-color-scheme: dark)')` and reacts to changes.
- Explicit light/dark ignores system changes.
- Compact density sets `data-density="compact"`.
- Code font size sets `--code-font-size` within 10–18px.
- Reduced motion sets `data-reduced-motion="true"`.
- Header theme toggle cycles light → dark while the Settings page can select system.

**Step 2: Run tests and verify failure**

Run: `npx vitest run test/default-theme.test.ts test/ui-preferences.test.ts`

Expected: FAIL because system theme and document attributes are unsupported.

**Step 3: Implement appearance application**

Make `Theme` include `system`. Keep the inline HTML bootstrap synchronous and resolve system preference before first paint. Subscribe to media-query changes only in system mode.

Add CSS rules:

```css
:root { --code-font-size: 12px; }
[data-density="compact"] { --settings-row-padding: 0.5rem; }
[data-reduced-motion="true"] *,
[data-reduced-motion="true"] *::before,
[data-reduced-motion="true"] *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
  transition-duration: 0.01ms !important;
}
```

Use `var(--code-font-size)` in terminal-adjacent code/log surfaces that currently hard-code 11–12px, but do not globally resize normal UI text.

**Step 4: Run tests**

Run: `npx vitest run test/default-theme.test.ts test/ui-preferences.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/web/client/index.html src/web/client/src/lib/theme.ts src/web/client/src/components/theme-toggle.tsx src/web/client/src/styles.css test/default-theme.test.ts test/ui-preferences.test.ts
git commit -m "feat: apply expanded appearance preferences"
```

### Task 7: Wire terminal preferences and termination safety

**Files:**
- Modify: `src/web/client/src/features/terminal/terminal-viewport.tsx`
- Modify: `src/web/client/src/features/terminal/terminal-pane.tsx`
- Modify: `src/web/client/src/features/terminal/terminal-view.tsx`
- Modify: `test/terminal-view.test.tsx`
- Create: `test/terminal-settings.test.tsx`

**Step 1: Write failing tests**

Verify that the xterm constructor receives `fontSize`, `cursorStyle`, and `scrollback`; that changing confirmed settings updates live xterm options; and that selecting terminal text copies it only when `copyOnSelect` is enabled. Verify close-tab, stop, and restart actions require confirmation when `confirmTerminate` is enabled and proceed directly when disabled.

**Step 2: Run tests and verify failure**

Run: `npx vitest run test/terminal-view.test.tsx test/terminal-settings.test.tsx`

Expected: FAIL because terminal settings are not consumed.

**Step 3: Apply xterm options**

Read terminal settings through `useSettings`. Pass a narrow `TerminalDisplaySettings` object into `TerminalViewport` to keep the viewport independently testable. Update `terminal.options` and refit when font size changes. Register and dispose the selection listener used by copy-on-select, handling clipboard rejection without crashing.

**Step 4: Add confirmation**

Use the existing `ConfirmDialog` component for closing a tab, stopping a PTY, and restarting a PTY. The dialog must name the action and explain that the running shell process will be terminated. Do not use `window.confirm`.

**Step 5: Run tests**

Run: `npx vitest run test/terminal-view.test.tsx test/terminal-settings.test.tsx`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/web/client/src/features/terminal test/terminal-view.test.tsx test/terminal-settings.test.tsx
git commit -m "feat: apply terminal preferences safely"
```

### Task 8: Wire project log and database preferences

**Files:**
- Modify: `src/web/client/src/features/services/log-viewer.tsx`
- Modify: `src/web/client/src/features/services/service-detail/log-console.tsx`
- Modify: `src/web/client/src/features/database/database-view.tsx`
- Modify: `src/web/client/src/features/database/sql-console.tsx`
- Modify: `src/web/client/src/features/database/table-grid.tsx`
- Create: `test/project-preferences.test.tsx`
- Modify: `test/database-view.test.tsx` if present, otherwise add focused cases to `test/project-preferences.test.tsx`

**Step 1: Write failing consumer tests**

Verify:

- `showTimestamps=false` removes the time gutter without removing timestamp text from search matching.
- `wrapLines=false` uses single-line preformatted log content with horizontal scrolling.
- `resultLimit` becomes the initial database browse/query limit but never silently truncates an explicitly requested lower limit.
- `confirmWrites=true` always presents the existing SQL approval step for a write, even when a connection is unlocked.
- Project preference changes do not alter another project's persisted config.

**Step 2: Run tests and verify failure**

Run: `npx vitest run test/project-preferences.test.tsx`

Expected: FAIL because consumers ignore project preferences.

**Step 3: Apply log preferences**

Pass `showTimestamps` and `wrapLines` to `LogViewer`. Derive the grid template and whitespace classes from those props. Keep `logEntryText()` unchanged so hidden timestamps remain searchable.

**Step 4: Apply database safety preferences**

Use the active project settings in `DatabaseView` and pass a narrow preference object into `SqlConsole` and browse hooks. Preserve the existing server-side write approval mechanism; the preference adds a client confirmation boundary and must not weaken backend authorization.

**Step 5: Run focused tests**

Run: `npx vitest run test/project-preferences.test.tsx test/database*.test.tsx`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/web/client/src/features/services/log-viewer.tsx src/web/client/src/features/services/service-detail/log-console.tsx src/web/client/src/features/database test/project-preferences.test.tsx test/database*.test.tsx
git commit -m "feat: apply project log and database settings"
```

### Task 9: Add export, reset, notification status, and external links

**Files:**
- Create: `src/web/client/src/features/settings/settings-actions.ts`
- Modify: `src/web/client/src/features/settings/settings-view.tsx`
- Modify: `src/web/client/src/features/settings/settings-context.tsx`
- Modify: `test/settings-view.test.tsx`
- Create: `test/settings-actions.test.ts`

**Step 1: Write failing action tests**

Verify:

- Export produces a versioned JSON document containing UI/global/project sections but no GitHub tokens, database URLs, or environment values.
- Reset UI preferences previews affected fields and preserves backend/project data.
- Reset project preferences is unavailable without an active project.
- Notification status reports unsupported, default, denied, or granted accurately.
- Request permission is only called after a user click.
- Docs, releases, and issue links use `target="_blank"` and `rel="noreferrer"`.

**Step 2: Run tests and verify failure**

Run: `npx vitest run test/settings-actions.test.ts test/settings-view.test.tsx`

Expected: FAIL because actions do not exist.

**Step 3: Implement safe export and reset**

Build the export document from the settings context only, never from the full dashboard config. Use a Blob and temporary object URL in the browser. Confirm reset with the existing `ConfirmDialog` and list the exact scope being cleared. Defer import to a follow-up because atomic multi-scope import needs a dedicated backend transaction endpoint.

**Step 4: Implement notification status and links**

Render permission/status and a request button only when the browser exposes `Notification`. Do not persist a separate “enabled” preference until an event notification service exists. Add links to:

- `https://www.nomoreide.com/docs`
- `https://github.com/Rorogogogo/nomoreide/releases`
- `https://github.com/Rorogogogo/nomoreide/issues/new`

**Step 5: Run tests**

Run: `npx vitest run test/settings-actions.test.ts test/settings-view.test.tsx`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/web/client/src/features/settings test/settings-actions.test.ts test/settings-view.test.tsx
git commit -m "feat: add safe settings management actions"
```

### Task 10: Integrate, verify, and document the first release

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-07-19-settings-hub-design.md` only if implementation discoveries require a factual correction

**Step 1: Run formatting and static checks**

Run: `npm run lint`

Expected: PASS with no new warnings.

Run: `npm run build`

Expected: PASS for Vite and TypeScript.

**Step 2: Run the complete test suite**

Run: `npm test`

Expected: all tests pass.

**Step 3: Start the development server**

Run: `npm run dev`

Expected: NoMoreIDE starts and reports the local dashboard URL.

**Step 4: Perform visual and interaction verification**

Use the `vercel:agent-browser-verify` skill. Verify `/settings` at a desktop viewport and a narrow mobile viewport in light, dark, and system themes. Exercise category navigation, search, immediate save, explicit numeric save, rollback by simulating a failed request, no-project state, confirmation dialogs, reset, external links, keyboard focus order, and terminal/log preference consumers.

Expected: no horizontal page overflow, no inaccessible controls, no fake toggles, and settings remain correct after reload.

**Step 5: Update documentation**

Add a concise Settings Hub section to `README.md` describing global versus current-project scope and where each settings document is stored. Do not claim deferred features.

**Step 6: Re-run verification after documentation changes**

Run: `npm run lint && npm run build && npm test`

Expected: PASS.

**Step 7: Commit**

```bash
git add README.md docs/plans/2026-07-19-settings-hub-design.md
git commit -m "docs: describe scoped settings hub"
```

**Step 8: Review the final diff**

Run: `git status --short && git log --oneline --decorate -12 && git diff main...HEAD --stat`

Expected: clean worktree; commits contain only settings-hub work. Before claiming completion, use `superpowers:verification-before-completion`, then use `superpowers:requesting-code-review` for an independent review.
