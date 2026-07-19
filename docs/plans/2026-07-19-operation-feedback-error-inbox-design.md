# Operation Feedback and Error Inbox Design

## Summary

NoMoreIDE needs consistent feedback for user-triggered asynchronous mutations and a cleaner way to scan error incidents. The solution combines immediate button-level feedback with a lightweight global operation surface, and refreshes the Error Inbox using the information architecture of the 21st.dev interactive logs table without replacing the app's live service-log console.

The application remains usable while work runs. Global blocking overlays and simulated progress percentages are deliberately excluded.

## Goals

- Give every meaningful mutation immediate, consistent feedback.
- Preserve feedback when a user navigates away from the initiating view.
- Prevent duplicate submissions without unnecessarily blocking unrelated work.
- Report success and failure accessibly and consistently.
- Make Error Inbox incidents faster to scan, search, filter, and inspect.
- Preserve NoMoreIDE-specific incident workflows such as Fix with AI and Review Changes.

## Non-goals

- Tracking ordinary background queries in the global operation surface.
- Replacing the terminal-style live service log viewer.
- Showing fake percentage progress for operations that do not expose real progress.
- Blocking the entire application for routine mutations.
- Copying the 21st.dev demo data model or full-screen layout directly.

## Existing Context

The client already uses TypeScript, Tailwind CSS, a shadcn-compatible component structure, Framer Motion, Lucide icons, and shared Button, Badge, Input, Loading, Spinner, and toast components. UI components live under `src/web/client/src/components/ui`.

The current Error Inbox already provides a live SSE incident feed, project scoping, grouped occurrence counts, incident details, Fix with AI, and Review Changes. Those capabilities remain authoritative.

## Operation Feedback Architecture

### Operation provider

Add an application-level operation provider responsible for active user-triggered mutations. Each operation has:

- a stable ID;
- a localized label;
- a status of `pending`, `success`, or `error`;
- optional scope and deduplication key;
- start time;
- optional error message;
- optional retry or navigation action when the caller can supply one.

The provider exposes an imperative `runOperation` helper that wraps a promise-producing action and guarantees consistent lifecycle transitions. It does not own domain data or replace feature-specific state. Features may retain local state where needed, while operation registration handles cross-page visibility.

Completed operations leave the active surface automatically. Success and error outcomes are announced through the existing toast system. The provider must tolerate overlapping operations and must not use a single global boolean.

### Async button

Extend the canonical shadcn-style Button with presentation-level pending support rather than introducing another parallel button implementation. The API should support:

- `loading`;
- an optional localized `loadingLabel`;
- automatic disabling and `aria-busy` while loading;
- stable button dimensions to avoid layout shifts;
- a standard inline Spinner;
- an optional short-lived success presentation where useful.

Business logic remains outside Button. A feature owns the async action and operation registration, then passes the resulting state into Button.

### Global operation surface

Render a compact, non-modal activity strip in the application shell. It appears only when a mutation remains pending beyond a short delay, preventing flicker for fast actions. It summarizes one operation directly and collapses multiple simultaneous operations into a count with an expandable list.

The surface must:

- allow navigation and unrelated interaction to continue;
- avoid covering the terminal dock and primary controls;
- expose pending state with `role="status"` and an appropriate live region;
- display real phase or progress data only when the underlying operation provides it;
- respect reduced-motion preferences.

### Timing

- Do not show global pending UI for operations completing in roughly 300 ms or less.
- Show the initiating button's pending state immediately.
- Remove successful operations promptly after announcing success.
- Keep failure details in a toast long enough to read and act upon.

## Operation Data Flow

1. A user activates a mutation control.
2. The feature prevents an unsafe duplicate and calls `runOperation` with metadata and its domain action.
3. The initiating button enters its loading state immediately.
4. If work exceeds the global delay, the operation strip becomes visible.
5. Domain state updates continue through the feature's existing refresh or optimistic-update path.
6. On success, the provider removes the pending operation and emits a success toast when confirmation is useful.
7. On failure, the provider removes the pending operation, restores the control, and emits an error toast with the best available recovery action.

## Error Inbox Redesign

### Layout

Replace the narrow master-detail incident list with a responsive incident table inspired by the supplied 21st.dev interactive logs table. The view has:

- a compact header with incident count and live/reconnecting status;
- search across service, title, file, and excerpt text;
- filters for severity, service, and relevant incident state;
- rows showing severity, latest timestamp, service, title, occurrence count, and source location when present;
- expandable inline detail content;
- an empty state for both no incidents and no filter matches.

Expanded content contains the full title, first/last occurrence metadata, source location, log excerpt, Fix with AI action, active-fix feedback, and Review Changes action.

### Data and behavior

The existing `useErrorIncidents` hook and `ErrorIncident` type remain the data source. Filtering and expansion are client-side because the incident feed is already held locally. Incoming SSE updates preserve the active search and filters, update matching rows in place, and keep newest-first ordering. Expanded state is keyed by incident ID.

Only one row is expanded at a time on compact layouts. Wider layouts may use the same rule initially to keep behavior predictable. Table semantics should be used where they remain responsive; the narrow layout may present each row as a compact card-like grid without horizontal overflow.

### Motion

Use Framer Motion only for subtle expansion and filter-panel transitions. Avoid per-row entrance staggering on a live feed because frequent incident updates would create distraction. Reduced-motion preferences disable nonessential transitions.

### Localization and accessibility

All new labels, filter values, empty states, operation messages, and accessibility text go through the existing English and Simplified Chinese catalogues. Controls have explicit labels, filter toggles expose pressed state, expandable rows expose `aria-expanded` and relationships to their detail regions, and status changes use live regions without repeatedly announcing streaming updates.

## Error Handling

- A failed initial incident fetch displays the existing inline Alert treatment while allowing SSE recovery.
- SSE disconnects retain existing incidents and change the connection badge to reconnecting.
- Fix with AI uses the shared async button and operation system; failure restores the action and produces an error toast.
- Unknown errors are normalized to a safe string at the feature boundary.
- Operation tracking cleanup occurs in `finally` paths so controls cannot remain permanently busy.

## Testing

### Operation feedback

- Button loading semantics, disabled state, labels, and stable content.
- Fast operations never reveal the delayed global strip.
- Slow and overlapping operations appear and clear independently.
- Success, failure, and rejected promises always clean up pending state.
- Duplicate keys prevent only the unsafe duplicate operation.
- Global status remains visible across page navigation.
- Reduced-motion and live-region behavior.

### Error Inbox

- Search and combined filters.
- Filter clearing and no-match state.
- Expansion, collapse, and keyboard activation.
- Incoming SSE insert/update while filters are active.
- Project scoping and newest-first ordering.
- Fix with AI pending, success, failure, and Review Changes behavior.
- Responsive narrow and wide layouts.
- English and Simplified Chinese catalogue coverage.

## Rollout

Implement the shared operation primitives first, migrate one representative mutation, and verify the interaction before converting remaining mutation buttons. Redesign the Error Inbox against its current live data contract in a separate step. Migrate mutation call sites incrementally so changes remain reviewable and feature-specific behavior can be tested in isolation.
