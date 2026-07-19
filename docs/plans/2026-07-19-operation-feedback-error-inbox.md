# Operation Feedback and Error Inbox Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add consistent mutation feedback through loading-aware buttons and a non-blocking global activity strip, then redesign Error Inbox as a searchable, filterable, expandable incident table.

**Architecture:** A small React context owns only the lifecycle metadata for user-triggered mutations; domain features continue owning their data and call the context's promise wrapper. The canonical Button renders immediate pending feedback, while an app-shell activity strip reveals slow operations after 300 ms. Error Inbox keeps its existing SSE hook and API contract but delegates filtering and responsive table presentation to testable incident-view components.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, shadcn-style components, Framer Motion, Lucide React, Vitest, happy-dom.

---

## Preconditions

- Execute in a dedicated worktree because the current main worktree contains unrelated user changes.
- Read `docs/plans/2026-07-19-operation-feedback-error-inbox-design.md` before starting.
- Use `@superpowers:test-driven-development` for each implementation task.
- Use `@vercel:react-best-practices` after the multi-component React edits.
- Use `@superpowers:verification-before-completion` before reporting completion.
- Do not copy the 21st.dev sample's `SAMPLE_LOGS`, full-screen shell, inline English strings, or simulated durations.

### Task 1: Add pending presentation to the canonical Button

**Files:**
- Modify: `src/web/client/src/components/ui/button.tsx`
- Test: `test/button-loading.test.tsx`

**Step 1: Write the failing tests**

Create `test/button-loading.test.tsx` with static-render assertions for:

```tsx
const html = renderToStaticMarkup(
  <Button loading loadingLabel="Saving…">Save</Button>,
);

expect(html).toContain('aria-busy="true"');
expect(html).toContain("Saving…");
expect(html).not.toContain(">Save<");
expect(html).toContain("animate-spin");
expect(html).toContain("disabled");
expect(html).not.toContain('loading=""');
```

Also assert that `loading` preserves a caller-supplied `disabled`, supports icon-sized buttons without a label, and renders ordinary children unchanged when false.

**Step 2: Run the focused test and verify failure**

Run: `npm test -- test/button-loading.test.tsx`

Expected: FAIL because Button does not accept or consume `loading` and `loadingLabel`.

**Step 3: Implement the minimal Button API**

Import the canonical `Spinner` from `@/components/ui/loading`, extend `ButtonProps` with:

```tsx
loading?: boolean;
loadingLabel?: React.ReactNode;
```

Destructure both props so they never reach the DOM. Set `disabled={disabled || loading}`, `aria-busy={loading || undefined}`, and render a stable inner wrapper whose visible contents switch to `Spinner` plus `loadingLabel ?? children`. Keep the current variants and sizes unchanged. Ensure an icon-only button shows only the spinner.

**Step 4: Run focused tests**

Run: `npm test -- test/button-loading.test.tsx`

Expected: PASS.

**Step 5: Run existing UI tests**

Run: `npm test -- test/dark-badge-styles.test.tsx test/setting-controls.test.tsx test/service-form-edit.test.tsx`

Expected: PASS with no Button markup regressions.

**Step 6: Commit**

```bash
git add src/web/client/src/components/ui/button.tsx test/button-loading.test.tsx
git commit -m "feat: add loading state to shared button"
```

### Task 2: Build the operation lifecycle provider

**Files:**
- Create: `src/web/client/src/components/operations/operation-context.tsx`
- Test: `test/operation-context.test.tsx`

**Step 1: Write provider lifecycle tests**

Use a deferred promise and a small harness rendered with `createRoot`. Cover:

- `runOperation` adds one pending operation synchronously;
- resolution removes it and returns the action result;
- rejection removes it and rethrows the original error;
- two unrelated operations coexist and clear independently;
- a duplicate `key` returns the existing promise or rejects the duplicate without running the action twice;
- provider unmount clears delayed callbacks without state updates.

The public types should be exercised as:

```tsx
type OperationInput = {
  key?: string;
  label: string;
  successMessage?: string;
  errorMessage?: (error: unknown) => string;
};

const result = await runOperation(
  { key: "service:web:start", label: "Starting web…" },
  () => startService("web"),
);
```

**Step 2: Run the test and verify failure**

Run: `npm test -- test/operation-context.test.tsx`

Expected: FAIL because the module does not exist.

**Step 3: Implement provider and hook**

Create `OperationProvider`, `useOperations`, and these exported types:

```tsx
export interface ActiveOperation {
  id: string;
  key?: string;
  label: string;
  startedAt: number;
}

export interface OperationContextValue {
  operations: ActiveOperation[];
  runOperation<T>(input: OperationInput, action: () => Promise<T>): Promise<T>;
  isPending(key: string): boolean;
}
```

Use a monotonically increasing ID or `crypto.randomUUID` with a deterministic fallback. Store active operations in state and use a ref for synchronous key deduplication. Always remove entries in `finally`. Call the existing toast helpers for supplied success/error messages, but do not invent generic success noise. Normalize unknown errors before calling `errorMessage`.

**Step 4: Run the lifecycle tests**

Run: `npm test -- test/operation-context.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/web/client/src/components/operations/operation-context.tsx test/operation-context.test.tsx
git commit -m "feat: track global mutation operations"
```

### Task 3: Add the delayed global operation strip

**Files:**
- Create: `src/web/client/src/components/operations/operation-strip.tsx`
- Modify: `src/web/client/src/lib/i18n/en.ts`
- Modify: `src/web/client/src/lib/i18n/zh.ts`
- Test: `test/operation-strip.test.tsx`

**Step 1: Write delayed-visibility tests**

Use fake timers. Verify:

- an operation younger than 300 ms renders no strip;
- advancing to 300 ms reveals `role="status"`;
- one operation renders its label;
- multiple operations render a localized count and an expandable list;
- completing all operations removes the strip;
- the toggle has `aria-expanded` and can be operated by keyboard/click;
- motion styling includes a reduced-motion-safe path.

**Step 2: Run and verify failure**

Run: `npm test -- test/operation-strip.test.tsx`

Expected: FAIL because the strip does not exist.

**Step 3: Implement the strip**

Use `useOperations()` and a single timer scheduled for the earliest operation's reveal time. Render a compact surface anchored inside the app shell, not a viewport-covering overlay. Suggested structure:

```tsx
<aside aria-live="polite" className="..." role="status">
  <Spinner size="sm" />
  <span>{summary}</span>
  {multiple ? <Button aria-expanded={open} variant="ghost" size="icon-sm">…</Button> : null}
</aside>
```

Add localized keys for `operation.multiple`, `operation.showDetails`, and `operation.hideDetails`. Use Tailwind `motion-reduce:transition-none` and no fake progress percentage.

**Step 4: Run tests**

Run: `npm test -- test/operation-strip.test.tsx test/settings-catalogue.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/web/client/src/components/operations/operation-strip.tsx src/web/client/src/lib/i18n/en.ts src/web/client/src/lib/i18n/zh.ts test/operation-strip.test.tsx
git commit -m "feat: show slow operations in app shell"
```

### Task 4: Mount operation feedback in the application shell

**Files:**
- Modify: `src/web/client/src/app.tsx`
- Test: `test/app-version.test.tsx`
- Test: `test/operation-context.test.tsx`

**Step 1: Add a failing app-shell assertion**

Add a small source or render assertion proving `App` nests `OperationProvider` outside `AppContent` and that `OperationStrip` is mounted once within the main shell. The strip must survive page changes because the provider is above page-specific views.

**Step 2: Run and verify failure**

Run: `npm test -- test/app-version.test.tsx test/operation-context.test.tsx`

Expected: FAIL because App does not mount the provider/strip.

**Step 3: Mount the provider and strip**

Use:

```tsx
<SettingsProvider>
  <OperationProvider>
    <AppContent syncLocation={syncLocation} />
  </OperationProvider>
</SettingsProvider>
```

Place `OperationStrip` immediately below the page header or other stable shell chrome. Confirm it does not overlap `RunningStripe` or the fixed agent terminal dock.

**Step 4: Run app tests**

Run: `npm test -- test/app-version.test.tsx test/operation-context.test.tsx test/agent-terminal-dock.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/web/client/src/app.tsx test/app-version.test.tsx test/operation-context.test.tsx
git commit -m "feat: mount global operation feedback"
```

### Task 5: Extract and test Error Inbox filtering

**Files:**
- Create: `src/web/client/src/features/errors/incident-filters.ts`
- Test: `test/error-inbox-ui.test.tsx`

**Step 1: Write failing pure-function tests**

Build incident fixtures covering error/warning, different services, source files, titles, excerpts, and counts. Test:

- case-insensitive search across service, title, file, and `logExcerpt`;
- severity and service filters;
- intersection across filter categories and union within one category;
- unchanged newest-first input order;
- active filter count;
- unique filter options sorted predictably.

Use a filter shape limited to the real API contract:

```tsx
export interface IncidentFilters {
  levels: IncidentLevel[];
  services: string[];
}
```

Do not add a status filter until the backend exposes a meaningful incident status.

**Step 2: Run and verify failure**

Run: `npm test -- test/error-inbox-ui.test.tsx`

Expected: FAIL because the filter module does not exist.

**Step 3: Implement pure helpers**

Export `filterIncidents`, `incidentMatchesQuery`, `incidentFilterOptions`, and `activeIncidentFilterCount`. Keep them free of React and locale-dependent display labels.

**Step 4: Run tests**

Run: `npm test -- test/error-inbox-ui.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/web/client/src/features/errors/incident-filters.ts test/error-inbox-ui.test.tsx
git commit -m "test: define error inbox filtering behavior"
```

### Task 6: Build the responsive incident table

**Files:**
- Create: `src/web/client/src/features/errors/incident-table.tsx`
- Modify: `src/web/client/src/features/errors/incident-detail.tsx`
- Modify: `src/web/client/src/lib/i18n/en.ts`
- Modify: `src/web/client/src/lib/i18n/zh.ts`
- Modify: `test/error-inbox-ui.test.tsx`

**Step 1: Add failing interaction and markup tests**

Render `IncidentTable` with fixture data and test:

- compact header count and live/reconnecting badge;
- search field filters visible rows;
- filter button exposes the active count;
- severity/service toggles expose `aria-pressed`;
- clear filters resets results;
- row toggle exposes `aria-expanded` and one detail region at a time;
- expanded detail contains log excerpt, source file, occurrence metadata, and actions;
- separate no-incidents and no-filter-match empty states;
- incoming rerender with an updated incident preserves query/filter/expanded ID;
- no hardcoded `h-screen` or demo-specific service/status values.

Mock `startFix`, `useAgentDock`, and toast helpers only for the action-specific assertions.

**Step 2: Run and verify failure**

Run: `npm test -- test/error-inbox-ui.test.tsx`

Expected: FAIL because `IncidentTable` does not exist.

**Step 3: Implement the table and filter panel**

Build the component from the supplied 21st.dev information architecture, adapted to current design tokens:

- semantic header and responsive row grid;
- `Input` with Lucide `Search`;
- shared `Button` and `Badge` variants;
- a 280 px filter panel on wide screens and stacked/overlay-safe controls on narrow screens;
- `AnimatePresence`/`motion` only for filter and detail expansion;
- no stagger animation for live row updates;
- `motion-reduce` or `useReducedMotion` handling;
- one expanded incident ID.

Refactor `IncidentDetail` into content suitable for an inline expansion. Remove its full-height page shell while retaining Fix with AI and Review Changes behavior. Accept a generated detail-region ID so the row can point to it with `aria-controls`.

**Step 4: Add localization**

Add English and Simplified Chinese keys for search, filter headings, clear, result count, severity/service labels, no matches, expand/collapse accessibility labels, message/excerpt, duration-equivalent occurrence metadata, and filter visibility.

**Step 5: Run focused tests**

Run: `npm test -- test/error-inbox-ui.test.tsx test/settings-catalogue.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/web/client/src/features/errors/incident-table.tsx src/web/client/src/features/errors/incident-detail.tsx src/web/client/src/lib/i18n/en.ts src/web/client/src/lib/i18n/zh.ts test/error-inbox-ui.test.tsx
git commit -m "feat: add searchable error incident table"
```

### Task 7: Connect the live Error Inbox container

**Files:**
- Modify: `src/web/client/src/features/errors/error-inbox-view.tsx`
- Modify: `test/error-inbox-ui.test.tsx`

**Step 1: Add a failing container test**

Mock `useErrorIncidents` and verify `ErrorInboxView`:

- project-filters incidents before handing them to the table;
- forwards `connected` and initial fetch `error`;
- forwards `onReviewChanges`;
- retains existing incidents when disconnected;
- no longer renders the old fixed-width master-detail list.

**Step 2: Run and verify failure**

Run: `npm test -- test/error-inbox-ui.test.tsx`

Expected: FAIL against the old layout.

**Step 3: Simplify the container**

Keep `useErrorIncidents()` and the existing `inScope` memoization in `ErrorInboxView`, then render `IncidentTable`. Keep fetch errors as an inline Alert owned by the table/container without discarding incidents received over SSE.

**Step 4: Run focused and backend error tests**

Run: `npm test -- test/error-inbox-ui.test.tsx test/error-inbox.test.ts test/fix-loop.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/web/client/src/features/errors/error-inbox-view.tsx test/error-inbox-ui.test.tsx
git commit -m "feat: connect live incidents to error table"
```

### Task 8: Use global operation feedback for Fix with AI

**Files:**
- Modify: `src/web/client/src/features/errors/incident-detail.tsx`
- Modify: `src/web/client/src/lib/i18n/en.ts`
- Modify: `src/web/client/src/lib/i18n/zh.ts`
- Modify: `test/error-inbox-ui.test.tsx`

**Step 1: Add failing action lifecycle tests**

Verify that clicking Fix with AI:

- registers key `error:{id}:fix` with a localized pending label;
- renders Button `loading` and its loading label immediately;
- refuses a duplicate click for the same incident;
- calls `sendToAgent` and reveals Review Changes on success;
- restores the action and emits the normalized error on failure.

**Step 2: Run and verify failure**

Run: `npm test -- test/error-inbox-ui.test.tsx`

Expected: FAIL because `IncidentDetail` uses only local `sending` state.

**Step 3: Migrate the action**

Use `useOperations()` and `isPending(key)`. Wrap `startFix` in `runOperation`, keep domain-specific `sendToAgent` and `fixedSessionId` updates in the action, and pass `loading`/`loadingLabel` to Button. Remove redundant local pending state and redundant error toast code now owned by the wrapper.

**Step 4: Run tests**

Run: `npm test -- test/error-inbox-ui.test.tsx test/fix-loop.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/web/client/src/features/errors/incident-detail.tsx src/web/client/src/lib/i18n/en.ts src/web/client/src/lib/i18n/zh.ts test/error-inbox-ui.test.tsx
git commit -m "feat: track error fix operations globally"
```

### Task 9: Migrate high-impact service and GitHub mutations

**Files:**
- Modify: `src/web/client/src/features/services/service-actions.tsx`
- Modify: `src/web/client/src/features/services/service-form/service-form.tsx`
- Modify: `src/web/client/src/features/github/issue-detail.tsx`
- Modify: `src/web/client/src/features/github/pr-detail.tsx`
- Modify: `src/web/client/src/features/github/github-view.tsx`
- Modify: `src/web/client/src/lib/i18n/en.ts`
- Modify: `src/web/client/src/lib/i18n/zh.ts`
- Test: `test/operation-mutations.test.tsx`

**Step 1: Write failing representative mutation tests**

Cover one mutation per domain before editing production code:

- service start/stop uses a service-and-action-specific key;
- service save uses a stable form key and loading label;
- issue comment posting shows `Posting…` and does not double-submit;
- PR squash merge remains pending while the request is unresolved;
- GitHub disconnect uses a scoped key and restores on rejection.

Assert that query-only refresh/load-more states are not registered globally.

**Step 2: Run and verify failure**

Run: `npm test -- test/operation-mutations.test.tsx`

Expected: FAIL because these features use local booleans only.

**Step 3: Migrate service mutations**

Wrap domain promises with `runOperation`, preserve current refresh/error behavior, and replace pending label ternaries with Button `loading`/`loadingLabel`. Do not globalize progressive background refresh callbacks.

**Step 4: Migrate GitHub mutations**

Use distinct keys such as `github:issue:{number}:comment`, `github:pr:{number}:merge`, and `github:disconnect`. Preserve confirmations and feature-specific success behavior. Do not globalize branch/PR list fetches or cockpit loading.

**Step 5: Run tests**

Run: `npm test -- test/operation-mutations.test.tsx test/service-form-edit.test.tsx test/github-view-source.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/web/client/src/features/services/service-actions.tsx src/web/client/src/features/services/service-form/service-form.tsx src/web/client/src/features/github/issue-detail.tsx src/web/client/src/features/github/pr-detail.tsx src/web/client/src/features/github/github-view.tsx src/web/client/src/lib/i18n/en.ts src/web/client/src/lib/i18n/zh.ts test/operation-mutations.test.tsx
git commit -m "feat: standardize core mutation feedback"
```

### Task 10: Migrate remaining explicit destructive/save busy states

**Files:**
- Modify: `src/web/client/src/features/database/add-connection-dialog.tsx`
- Modify: `src/web/client/src/features/database/sql-console.tsx`
- Modify: `src/web/client/src/features/agent/changes-tab.tsx`
- Modify: `src/web/client/src/features/agent-env/agent-settings-dialog.tsx`
- Modify: `src/web/client/src/features/agent-env/profile-contents.tsx`
- Modify: `src/web/client/src/features/settings/setting-controls.tsx`
- Modify: `src/web/client/src/lib/i18n/en.ts`
- Modify: `src/web/client/src/lib/i18n/zh.ts`
- Modify: `test/operation-mutations.test.tsx`

**Step 1: Inventory only mutations**

Before editing, list controls that create, update, delete, apply, restore, or execute writes. Exclude initial detection, ordinary fetches, polling, file pickers, editor loading, and other read-only work. Record operation keys in the test table to prevent accidental global loading scope creep.

**Step 2: Add failing tests for dangerous duplicates**

At minimum cover database connection save, confirmed SQL write, change-set restore, agent settings save, profile patch/apply, and settings number save. Assert only the initiating/unsafe controls disable.

**Step 3: Run and verify failure**

Run: `npm test -- test/operation-mutations.test.tsx test/setting-controls.test.tsx test/project-preferences.test.tsx`

Expected: FAIL until each mutation uses operation tracking.

**Step 4: Migrate domain by domain**

Use `runOperation` with localized labels and domain-specific keys. Retain local state only where it controls dialog steps or domain output rather than generic pending presentation. Never allow a toast/provider failure to swallow the domain promise rejection.

**Step 5: Run focused tests**

Run: `npm test -- test/operation-mutations.test.tsx test/setting-controls.test.tsx test/project-preferences.test.tsx test/agent-env-actions.test.ts test/db-write.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/web/client/src/features/database/add-connection-dialog.tsx src/web/client/src/features/database/sql-console.tsx src/web/client/src/features/agent/changes-tab.tsx src/web/client/src/features/agent-env/agent-settings-dialog.tsx src/web/client/src/features/agent-env/profile-contents.tsx src/web/client/src/features/settings/setting-controls.tsx src/web/client/src/lib/i18n/en.ts src/web/client/src/lib/i18n/zh.ts test/operation-mutations.test.tsx
git commit -m "feat: track destructive and save operations"
```

### Task 11: Remove duplicate loading primitives where safe

**Files:**
- Modify: `src/web/client/src/components/ui/button-1.tsx`
- Modify: `src/web/client/src/components/ui/toast.tsx`
- Modify or delete: `src/web/client/src/components/ui/spinner-1.tsx`
- Modify: `src/web/client/src/components/ui/toast-demo.tsx`
- Test: `test/button-loading.test.tsx`

**Step 1: Prove actual imports**

Run: `rg -n 'button-1|spinner-1' src/web/client/src test`

Expected before migration: only toast/demo paths depend on these parallel primitives.

**Step 2: Add a regression assertion**

Assert toast actions render through the canonical Button and no production source imports `button-1` or `spinner-1`.

**Step 3: Migrate toast imports**

Replace the legacy button usage with canonical Button variants/sizes. Delete legacy files only after `rg` returns no imports. Preserve toast layout and behavior; do not redesign toast styling in this task.

**Step 4: Run tests and build**

Run: `npm test -- test/button-loading.test.tsx test/website-toast-theme.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS with no unresolved imports.

**Step 5: Commit**

```bash
git add src/web/client/src/components/ui/button-1.tsx src/web/client/src/components/ui/spinner-1.tsx src/web/client/src/components/ui/toast.tsx src/web/client/src/components/ui/toast-demo.tsx test/button-loading.test.tsx
git commit -m "refactor: consolidate loading primitives"
```

Use `git add -u` instead if the two legacy files are deleted.

### Task 12: Full verification and visual review

**Files:**
- Modify only if verification reveals a scoped defect.

**Step 1: Run formatting and static checks**

Run: `npm run lint`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

**Step 2: Run the complete test suite**

Run: `npm test`

Expected: PASS.

**Step 3: Start the application for browser verification**

Run: `npm run dev:web`

Expected: Vite serves the client without runtime errors.

Use `@vercel:agent-browser-verify` to verify:

- a fast mutation does not flash the global strip;
- a delayed mutation shows both button and global feedback;
- navigation does not lose the delayed operation;
- two operations expand into a readable list;
- failure restores the action and shows an error toast;
- Error Inbox search, filters, expansion, live/reconnecting badge, Fix with AI, and Review Changes work;
- narrow and wide layouts have no horizontal clipping;
- dark/light themes and English/Simplified Chinese labels remain legible;
- reduced-motion mode removes nonessential motion.

**Step 4: Review scope**

Run: `git diff --stat <base-commit>...HEAD`

Expected: only operation-feedback, Error Inbox, localization, tests, and removal of superseded loading primitives are changed. Confirm no unrelated user changes were incorporated.

**Step 5: Final commit if verification required fixes**

```bash
git add <only-the-verified-fix-files>
git commit -m "fix: polish operation and incident feedback"
```

**Step 6: Request code review**

Use `@superpowers:requesting-code-review` against the full implementation diff. Address only verified, in-scope findings, then rerun the affected tests plus `npm run build`.
