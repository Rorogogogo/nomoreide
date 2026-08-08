# DESIGN.md

How NoMoreIDE looks and why. Derived from the pages that already exist — this
documents the taste the codebase settled into, it does not propose a new one.

Read this before building a view. It is deliberately short; when it doesn't
cover your case, copy the nearest existing view rather than inventing.

---

## The thesis

**Dense rows, quiet chrome.**

We borrow two references that pull in opposite directions. Dev tools (GitHub,
Vercel, a debugger) are information-dense and status-colored. ChatGPT's UI is
calm, uncluttered, almost furniture-free. The synthesis is not "medium density
everywhere" — it is:

- **Inside a list: dense.** Small type, tight rows, monospace where it's an
  identifier, real numbers rather than words. A developer reading their own
  project wants facts per pixel.
- **Around the list: silent.** No panel headers stacked on panel headers, no
  card borders wrapping things that are already visually grouped, no decorative
  icons, no gradients, no drop shadows in the content area.

Elegance here is a *subtraction* result. It comes from removing chrome until
only the data and the rules between it remain — plus a warm, slightly unusual
palette so the result reads as considered rather than unstyled. It never comes
from adding ornament.

---

## Foundations

### Color

Tokens live in `src/web/client/src/styles.css` as HSL triples, exposed to
Tailwind via `@theme inline`. **Always use the semantic token** (`bg-card`,
`text-muted-foreground`, `border-border`) — never a raw Tailwind gray.

The palette is a **warm** neutral (hues 24–42), not the default cool gray. Dark
mode is a warm near-black (`24 10% 6%`), not `#000`. This is most of why the app
doesn't look like an unstyled Tailwind admin panel — protect it.

The accent is **teal** (`170 34% 39%`), used for focus rings and selection.
It is deliberately not blue or violet.

Vercel Geist tokens (`--ds-*`) are layered in for shadows and focus rings on
overlay surfaces (menus, popovers). Use them there; don't reach for them in
content.

### Status colors

The only place saturated color is allowed. Meaning is fixed:

| Color | Means |
| --- | --- |
| `emerald` | success, open, healthy, running-and-fine |
| `red` | failure, error, destructive |
| `amber` | in progress, queued, warning, needs attention |
| `purple` | merged |
| `zinc` | skipped, cancelled, inert |

Use the 500 weight on dark-capable surfaces; step to 600/700 for text on light
backgrounds where 500 fails contrast.

### Type

One family, one tight scale. Sizes are set explicitly in `px` because the app is
a dense tool, not a document.

| Size | Role |
| --- | --- |
| `text-[13px]` | row titles, section titles — the only "heading" most views get |
| `text-[12px]` | body text, prose, empty states |
| `text-[11px]` | **the workhorse** — meta lines, tab labels, controls |
| `text-[10px]` | uppercase labels, timestamps, counters |
| `text-[9px]` | micro-annotations only |

Nothing bigger than 13px in a normal view. If a number needs emphasis, use
`font-semibold` and `tabular-nums`, not a larger size.

`font-mono` is used heavily (300+ call sites) and carries meaning: **it marks a
machine identifier** — a path, branch, SHA, port, env key. Never use it for
prose.

### Spacing & shape

- Row / cell padding: **`px-3 py-2`** is the default. `py-2.5` for list rows with
  a two-line body, `py-1`–`py-1.5` for chrome strips.
- Radius: `--radius: 0.5rem`. Buttons `rounded-md`, small inline chips `rounded`.
- Content areas get **no shadow**. Shadows belong to overlays only.

---

## The layout law: lines, not boxes

This is the rule that most defines the look, and the one most often broken.

**Separate content with rules. Do not wrap content in cards.**

```tsx
// Yes — a list is a stack of rows divided by hairlines
<ul className="divide-y divide-border">
  <li>…</li>
</ul>

// Yes — a section boundary is one border
<div className="border-b border-border px-3 py-2">…</div>

// No — a card around something the page already groups
<div className="rounded-lg border border-border bg-card p-4">…</div>
```

Cards are for genuinely floating objects: dialogs, popovers, an empty-state
island in the middle of a blank page. A section of a page is not a floating
object.

The same applies horizontally: split counters with `divide-x divide-border`,
not by making each one a tile.

**Full-bleed by default.** Content runs to the panel edges. Don't center a
`max-w-*` column inside a workbench panel — it strands the content on wide
screens and reads as a marketing page.

---

## The row

The row is the atom of this UI. Almost every view is a list of them.

```tsx
<button className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
  <StatusIcon />                                       {/* size-4 shrink-0 */}
  <span className="min-w-0 flex-1">
    <span className="block truncate text-[13px] font-medium">{title}</span>
    <span className="block truncate text-[11px] text-muted-foreground">
      {identifier} · {context} · {who}
    </span>
  </span>
  <span className="shrink-0 text-[10px] text-muted-foreground">{when}</span>
</button>
```

Rules that make rows work:

- **Status mark on the left, always `size-4 shrink-0`.** It is the fastest read
  on the page.
- **Two lines maximum**: title, then a `·`-joined meta line. Everything else is
  a shrink-0 accessory on the right.
- **`min-w-0` on the flexible cell and `truncate` on its text**, or long branch
  names will blow out the layout.
- **Rows are clickable when there is anywhere to go.** A row that shows a PR
  should open that PR. A dashboard of dead-end rows is a poster, not a tool.
- Selected reads `bg-muted/45`; hover reads `hover:bg-muted/20`.

---

## Chrome

Keep it to three pieces.

**Page tabs** — `TabStrip` (`components/ui/tab-strip.tsx`). 11px, selected is
`bg-foreground text-background`. Don't hand-roll another one.

**State filters** — `StateFilter` from the same file. Deliberately *not* the tab
treatment: it scopes the current list rather than switching views, so it stays a
quiet segmented control.

**Section headers** — a thin rule, not a heading:

```tsx
<div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-1">
  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
    {title}
  </span>
  {/* optional quiet "View all" action */}
</div>
```

Buttons: `default` for the one primary action, `outline` for secondary, `ghost`
for tertiary/icon. Most views need zero `default` buttons.

---

## Motion

Motion exists to show that something is **happening right now**. Nothing else.

- A spinning ring means work is in flight (`RunningRing` in
  `features/github/status-octicons.tsx`). A static or pulsing dot means *parked* —
  queued, unknown. Don't mix these up; the distinction carries real information.
- `transition-colors` on anything hoverable. No transitions on layout or size.
- No entrance animations for content. Lists appear; they don't fly in.
- Always honor `[data-reduced-motion="true"]` — it's already wired globally in
  `styles.css`, so just don't fight it with inline animation.

---

## Density and access

- `[data-density="compact"]` is a real user setting. Use the `.settings-row`
  class / `--settings-row-padding` for settings-style rows rather than hardcoding.
- Every interactive element needs
  `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`
  (add `ring-inset` on full-bleed rows).
- Every user-visible string goes through `useT()` — and lands in **both**
  `en.ts` and `zh.ts` in the same change. A key missing from `zh` silently falls
  back to English rather than failing the build.

---

## Don't

- Wrap a page section in a card.
- Center a narrow column inside a panel.
- Invent a font size outside the scale.
- Use saturated color for anything but status.
- Add an icon that doesn't disambiguate a state.
- Build a summary view whose rows don't go anywhere.
- Stack two header bars on one panel.
- Use `font-mono` for prose, or a sans identifier.

## Before you ship

1. Zero `rounded-lg border` in the content area?
2. All type within 9–13px?
3. Rows clickable, `min-w-0` + `truncate` applied?
4. Focus ring on every interactive element?
5. Both `en.ts` and `zh.ts` updated?
6. `npx tsc -p src/web/client/tsconfig.json --noEmit` and `npx biome check` clean?
   (Neither runs in CI — see CLAUDE.md.)
