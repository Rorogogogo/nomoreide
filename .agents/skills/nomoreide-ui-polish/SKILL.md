---
name: nomoreide-ui-polish
description: Apply NoMoreIDE's compact, flat visual language to React dashboard surfaces. Use when polishing, simplifying, restyling, or making Git, Docker, Activity, Services, or another NoMoreIDE page visually consistent; when the user asks for the "same style"; or when reviewing UI density, hierarchy, tabs, lists, detail panes, tables, badges, charts, motion, and empty/loading states.
---

# NoMoreIDE UI Polish

Refine interfaces toward the simplest useful expression: content first, one clear hierarchy, minimal decoration, and no loss of capability. Combine OpenAI-like restraint with NoMoreIDE's dense developer-tool character.

## Establish the local baseline

Inspect the target component and the closest polished sibling before editing. Prefer these references:

- `src/web/client/src/features/docker/docker-view.tsx` for compact tabs, inline summaries, and list/detail layout.
- `src/web/client/src/features/docker/docker-container-row.tsx` for dense actionable rows.
- `src/web/client/src/features/docker/docker-detail-panel.tsx` for bounded detail panes and section disclosure.
- `src/web/client/src/features/activity/activity-view.tsx` for flat monitoring surfaces, tables, and chart treatment.
- `src/web/client/src/components/ui/cvui-badge.tsx` for semantic badges.

Preserve the target page's information architecture when it already serves the workflow. Simplify presentation before restructuring behavior.

## Apply the visual language

### Surfaces and hierarchy

- Use `bg-background` as the page canvas.
- Prefer full-width content with thin `border-border` or `border-border/70` separators.
- Remove decorative gradients, glows, card stacking, heavy shadows, and redundant tinted layers.
- Use a rounded bordered container only when it materially defines an interactive or visual boundary, such as a chart, terminal, code block, dialog, or focused inspector.
- Avoid wrapping every section in a card. Let spacing, typography, and separators carry hierarchy.

### Density and typography

- Keep headers compact, usually `px-3 py-2`.
- Use small, legible controls: page tabs around `text-[11px]`; metadata and summaries around `text-[9px]` to `text-[10px]`.
- Use normal UI type for labels and names; use mono and tabular numerals for commands, paths, IDs, metrics, and timestamps.
- Show secondary context inline or directly below the primary label. Truncate long paths and commands with a useful `title`.

### Controls and state

- Reuse existing shadcn/CVUI primitives instead of creating local lookalikes.
- Style compact selected tabs as `bg-foreground text-background`; inactive tabs use muted text with a foreground hover.
- Keep action buttons native and keyboard reachable. Use icon buttons only when the icon is familiar and a tooltip/accessible label is present.
- Use semantic colors sparingly: emerald for healthy/start, amber for warning/restart, red or rose for destructive/stop/error, sky for informational metrics.
- Keep badges compact and semantic. Do not use badges as decoration.

### Lists, tables, and detail panes

- Make lists and resource tables fill their available width.
- Use quiet row hover (`bg-muted/20`) and selected (`bg-muted/45`) states; avoid thick outlines unless they communicate drag/drop or focus.
- Prefer split list/detail layouts for inspectable resources. Keep pane boundaries to a single separator.
- Use in-place skeletons for loading details so the surrounding layout does not jump.
- Preserve scroll position during background refreshes and avoid remounting stable tables or panels without reason.
- Use independent collapsible sections when a detail pane contains several data groups.

### Charts and motion

- Keep charts bounded and rounded because the plotting rectangle improves reading.
- Inset plot values from SVG top and bottom by about 4% so boundary strokes, dots, and 0/100 labels do not clip.
- Derive paths, fills, gridlines, reference lines, labels, and markers from the same plotting scale.
- Use short, subtle transitions for spatial changes. Add `motion-reduce` fallbacks and never make decoration continuously animate.

### Accessibility and product behavior

- Preserve native buttons, tab semantics, focus rings, accessible names, live regions, and keyboard behavior.
- Mark decorative icons `aria-hidden`.
- Keep existing translations and add i18n keys for new user-facing text.
- Do not remove actions, diagnostics, safety confirmations, guarded writes, refresh behavior, or responsive fallbacks merely to make the UI cleaner.

## Work safely

1. Inspect `git status` and the target diff. Preserve unrelated dirty worktree changes.
2. Identify the smallest vertical slice that achieves consistency.
3. Edit existing components and shared primitives deliberately; avoid broad style churn.
4. Add focused regression coverage for behavior or boundary bugs.
5. Run focused tests and Biome checks, then `npm run build` and `git diff --check`.
6. Report any repository-wide lint diagnostics that predate the polish separately.

## Review test

Before finishing, ask:

- Is every visible layer doing useful work?
- Is the primary action or state obvious without decorative emphasis?
- Do related pages now feel like one product?
- Did density improve without harming readability or touch/keyboard access?
- Do 0%, 100%, loading, empty, long-text, narrow-screen, and reduced-motion states still work?
