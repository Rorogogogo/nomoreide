# Agent Terminal Full-Screen Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full-screen agent terminal with horizontal app navigation that exits and collapses the dock when a destination is selected.

**Architecture:** Keep page routing in `App` and full-screen presentation in `AgentTerminalDock`. Pass page metadata and one navigation callback into the dock; do not duplicate route state or remount terminal sessions.

**Tech Stack:** React, TypeScript, Tailwind CSS, Vitest, happy-dom.

---

### Task 1: Specify full-screen dock behavior

**Files:**
- Modify: `test/agent-terminal-dock.test.tsx`

1. Add failing tests for Expand/Restore, Escape, horizontal navigation, and collapse-on-navigation.
2. Run the focused test and verify the new assertions fail for missing behavior.

### Task 2: Implement full-screen presentation

**Files:**
- Modify: `src/web/client/src/features/agent/terminal/agent-terminal-dock.tsx`

1. Add local full-screen state and toolbar controls.
2. Render a horizontal navigation bar only in full-screen mode.
3. Fill the app area below the native title bar without unmounting task viewports.
4. Restore with Escape and collapse directly to the rail.
5. Run the focused dock tests.

### Task 3: Connect application routing

**Files:**
- Modify: `src/web/client/src/app.tsx`
- Modify: `test/app-shell.test.tsx` or the closest existing app navigation test

1. Export/reuse the page type and pass current page plus a navigation callback to the dock.
2. Verify horizontal navigation changes the route/page and collapses the dock.
3. Run the focused app tests.

### Task 4: Verify

1. Run the dock, app-shell, terminal viewport, and context test suites.
2. Run the production build and TypeScript compiler.
3. Audit the diff to preserve unrelated changes.
