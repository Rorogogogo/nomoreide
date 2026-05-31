# Documentation and AI Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a human-friendly `/docs` website page plus AI-fetchable documentation files for NoMoreIDE.

**Architecture:** Keep the website as a lightweight Vite SPA with a pathname switch in `website/src/App.tsx`. Add a focused `DocsPage` component for human docs and plain public files for AI ingestion. Add repo source docs under `docs/` so the website docs have maintainable source material without introducing a docs framework.

**Tech Stack:** React 19, Vite 7, Tailwind CSS 4, lucide-react, Vitest static source tests, Markdown/plain-text public assets.

---

## File Structure

- Create `website/src/components/docs-page.tsx`: renders the `/docs` documentation page with table of contents, code blocks, tool reference, safety guide, troubleshooting, and AI links.
- Modify `website/src/App.tsx`: switch between the existing landing page and `DocsPage` based on `window.location.pathname`.
- Modify `website/src/components/hero.tsx`: add a `/docs` hero action while preserving `#hero-demo` and `#mcp-setup`.
- Modify `website/src/components/cta.tsx`: point "Read the docs" at `/docs`.
- Modify `website/src/components/footer.tsx`: add/update the docs nav link.
- Create `docs/usage-guide.md`: repo-maintained comprehensive user guide.
- Create `docs/ai-agent-guide.md`: repo-maintained agent guide and prompt reference.
- Create `website/public/llms.txt`: short AI index.
- Create `website/public/llms-full.txt`: full AI-readable plain-text documentation.
- Create `website/public/docs/ai-guide.md`: fetchable Markdown agent guide.
- Create `test/website-docs.test.ts`: static tests for `/docs` routing, links, and public AI files.

## Task 1: Add Static Tests for Docs Routing and AI Assets

**Files:**
- Create: `test/website-docs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/website-docs.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");
const appSource = readFileSync(resolve(root, "website/src/App.tsx"), "utf8");
const heroSource = readFileSync(resolve(root, "website/src/components/hero.tsx"), "utf8");
const ctaSource = readFileSync(resolve(root, "website/src/components/cta.tsx"), "utf8");
const footerSource = readFileSync(resolve(root, "website/src/components/footer.tsx"), "utf8");

describe("website docs", () => {
  test("routes /docs to the documentation page", () => {
    expect(appSource).toContain("DocsPage");
    expect(appSource).toContain('window.location.pathname === "/docs"');
  });

  test("links the landing page to /docs without replacing the live mock link", () => {
    expect(heroSource).toContain('href="#hero-demo"');
    expect(heroSource).toContain('href="/docs"');
    expect(ctaSource).toContain('href="/docs"');
    expect(footerSource).toContain('href="/docs"');
  });

  test("publishes AI-fetchable documentation assets", () => {
    const llmsPath = resolve(root, "website/public/llms.txt");
    const fullPath = resolve(root, "website/public/llms-full.txt");
    const aiGuidePath = resolve(root, "website/public/docs/ai-guide.md");

    expect(existsSync(llmsPath)).toBe(true);
    expect(existsSync(fullPath)).toBe(true);
    expect(existsSync(aiGuidePath)).toBe(true);

    const llms = readFileSync(llmsPath, "utf8");
    const full = readFileSync(fullPath, "utf8");
    const aiGuide = readFileSync(aiGuidePath, "utf8");

    expect(llms).toContain("NoMoreIDE");
    expect(llms).toContain("https://www.nomoreide.com/llms-full.txt");
    expect(full).toContain("MCP Tool Reference");
    expect(full).toContain("Safety Model");
    expect(aiGuide).toContain("# NoMoreIDE AI Agent Guide");
    expect(aiGuide).toContain("nomoreide_list_services");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run test/website-docs.test.ts
```

Expected: FAIL because `DocsPage`, `/docs` links, and public docs assets do not exist yet.

## Task 2: Add Source Documentation and Public AI Assets

**Files:**
- Create: `docs/usage-guide.md`
- Create: `docs/ai-agent-guide.md`
- Create: `website/public/llms.txt`
- Create: `website/public/llms-full.txt`
- Create: `website/public/docs/ai-guide.md`

- [ ] **Step 1: Create `docs/usage-guide.md`**

Create a Markdown guide with these exact top-level and second-level headings:

```md
# NoMoreIDE Usage Guide

## Overview
## Quick Start
## MCP Setup
## Running Interfaces
## CLI Reference
## Web Dashboard Guide
## MCP Tool Reference
## Configuration Model
## Safety Model
## Troubleshooting
## Architecture
## Development
## Licensing
```

The body must include the current setup commands:

```bash
npx -y nomoreide
npm install -g nomoreide
claude mcp add --transport stdio nomoreide -- npx -y nomoreide
codex mcp add nomoreide -- npx -y nomoreide
```

Include the Gemini config:

```json
{
  "mcpServers": {
    "nomoreide": {
      "command": "npx",
      "args": ["-y", "nomoreide"]
    }
  }
}
```

Include the MCP tool groups and tool names from `src/mcp/tools/*`:

```text
Service: nomoreide_list_services, nomoreide_register_service, nomoreide_start_service, nomoreide_stop_service, nomoreide_restart_service, nomoreide_read_logs, nomoreide_register_bundle, nomoreide_start_bundle, nomoreide_stop_bundle, nomoreide_status, nomoreide_service_context, nomoreide_service_health, nomoreide_timeline
Onboard: nomoreide_onboard_repo
Git: nomoreide_git_status, nomoreide_git_branches, nomoreide_git_switch_branch, nomoreide_git_create_branch, nomoreide_git_fetch, nomoreide_git_diff, nomoreide_git_staged_diff, nomoreide_git_log, nomoreide_git_stage, nomoreide_git_unstage, nomoreide_git_commit, nomoreide_git_register_repository, nomoreide_git_select_repository
Error: nomoreide_list_errors, nomoreide_error_prompt
Database: nomoreide_list_databases, nomoreide_db_tables, nomoreide_db_sample
Agent/UI: nomoreide_open_ui, nomoreide_close_ui
```

- [ ] **Step 2: Create `docs/ai-agent-guide.md`**

Create a Markdown guide beginning with:

```md
# NoMoreIDE AI Agent Guide

This guide is written for AI coding agents using NoMoreIDE through MCP.
```

Include sections:

```md
## Setup Prompt
## Session Operating Prompt
## Recommended Workflow
## Service Debugging Workflow
## Git Review Workflow
## Database Inspection Workflow
## Safety Rules
## Tool Reference
```

Include this setup prompt:

```text
Please set up NoMoreIDE as a local MCP server for this agent. Register a server named nomoreide that runs npx -y nomoreide. After adding it, tell me how to verify it with /mcp.
```

Include this operating prompt:

```text
Use NoMoreIDE as the shared local workbench for this session. Start by calling nomoreide_list_services and nomoreide_status. Before changing service state, check nomoreide_service_health and recent logs. For Git work, inspect status and diffs before staging or committing. Prefer NoMoreIDE tools over ad hoc shell commands when a matching tool exists.
```

- [ ] **Step 3: Create public AI assets**

Create `website/public/docs/ai-guide.md` by copying the content of `docs/ai-agent-guide.md`.

Create `website/public/llms.txt` with:

```text
# NoMoreIDE

NoMoreIDE is an AI-native local development workbench for services, logs, Git review, database inspection, terminal access, and MCP workflows.

Primary documentation:
- Human docs: https://www.nomoreide.com/docs
- Full AI docs: https://www.nomoreide.com/llms-full.txt
- AI agent guide: https://www.nomoreide.com/docs/ai-guide.md
- GitHub: https://github.com/Rorogogogo/nomoreide
- npm: https://www.npmjs.com/package/nomoreide

Quick setup:
claude mcp add --transport stdio nomoreide -- npx -y nomoreide
codex mcp add nomoreide -- npx -y nomoreide

Gemini MCP server:
{"mcpServers":{"nomoreide":{"command":"npx","args":["-y","nomoreide"]}}}

Verify inside the agent with /mcp.
```

Create `website/public/llms-full.txt` as plain text with the same coverage as `docs/usage-guide.md` and `docs/ai-agent-guide.md`. Ensure it includes the exact headings `MCP Tool Reference` and `Safety Model`.

- [ ] **Step 4: Run the docs asset test section**

Run:

```bash
npx vitest run test/website-docs.test.ts
```

Expected: still FAIL until routing and landing links are implemented, but the asset assertions should now pass.

## Task 3: Add the Website Docs Page

**Files:**
- Create: `website/src/components/docs-page.tsx`

- [ ] **Step 1: Create the docs page component**

Create `website/src/components/docs-page.tsx` exporting `DocsPage`. It should:

- Import `ArrowLeft`, `Bot`, `BookOpen`, `Copy`, `ExternalLink`, `ShieldCheck`, `Terminal`, and `Wrench` from `lucide-react`.
- Import `useState` from React.
- Import `Button` from `./ui/button`.
- Render a full page with `id` anchors for:
  - `overview`
  - `quick-start`
  - `mcp-setup`
  - `interfaces`
  - `cli`
  - `dashboard`
  - `mcp-tools`
  - `configuration`
  - `safety`
  - `ai-agent-guide`
  - `troubleshooting`
  - `architecture`
  - `development`
  - `license`
- Include code blocks for Claude, Codex, Gemini, CLI service registration, Git commands, and development commands.
- Include links to `/llms.txt`, `/llms-full.txt`, and `/docs/ai-guide.md`.

Use a local `CopyButton` component:

```tsx
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onClick={copy}
      type="button"
    >
      <Copy className="size-3.5" />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
```

Use this helper for code blocks:

```tsx
function CodeBlock({ code, language = "bash" }: { code: string; language?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {language}
        </span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-6">
        <code>{code}</code>
      </pre>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck the component through the website build**

Run:

```bash
npm --prefix website run build
```

Expected before routing may still PASS if the component is not imported, but TypeScript should catch syntax if imported in the next task.

## Task 4: Route `/docs` and Update Landing Links

**Files:**
- Modify: `website/src/App.tsx`
- Modify: `website/src/components/hero.tsx`
- Modify: `website/src/components/cta.tsx`
- Modify: `website/src/components/footer.tsx`

- [ ] **Step 1: Add docs route switch in `website/src/App.tsx`**

Change `website/src/App.tsx` to import `DocsPage`:

```tsx
import { DocsPage } from "./components/docs-page";
```

Change the component body to:

```tsx
export default function App() {
  if (window.location.pathname === "/docs") {
    return <DocsPage />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Hero />
      <Features />
      <HowItWorks />
      <CTA />
      <Footer />
    </div>
  );
}
```

- [ ] **Step 2: Add `/docs` link in `website/src/components/hero.tsx`**

In the hero button row, keep the existing live mock and MCP buttons, and add a docs action:

```tsx
<Button asChild size="lg" variant="outline">
  <a href="/docs">Read the docs</a>
</Button>
```

Keep this existing link unchanged:

```tsx
<a href="#hero-demo">Try the live mock</a>
```

- [ ] **Step 3: Update CTA docs link**

In `website/src/components/cta.tsx`, change the docs button anchor to:

```tsx
<a href="/docs">Read the docs</a>
```

- [ ] **Step 4: Update footer docs link**

In `website/src/components/footer.tsx`, include:

```tsx
<a href="/docs" className="transition hover:text-foreground">
  Docs
</a>
```

Keep the existing GitHub, License, MCP setup, and Issues links unless space forces replacing the GitHub README link.

- [ ] **Step 5: Run the docs test**

Run:

```bash
npx vitest run test/website-docs.test.ts
```

Expected: PASS.

## Task 5: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused website tests**

Run:

```bash
npx vitest run test/website-docs.test.ts test/website-hero.test.ts test/website-build-preflight.test.ts
```

Expected: PASS.

- [ ] **Step 2: Build the website**

Run:

```bash
npm --prefix website run build
```

Expected: PASS with Vite build output and public docs copied into `website/dist`.

- [ ] **Step 3: Check git status for intended files**

Run:

```bash
git status --short docs website test/website-docs.test.ts
```

Expected: only the plan, source docs, website docs page, website public docs assets, landing link files, and test file should be new or modified for this implementation. Existing unrelated unstaged files elsewhere must remain untouched.

- [ ] **Step 4: Commit implementation**

Run:

```bash
git add docs/usage-guide.md docs/ai-agent-guide.md docs/superpowers/plans/2026-05-31-documentation-and-ai-guide.md website/src/App.tsx website/src/components/docs-page.tsx website/src/components/hero.tsx website/src/components/cta.tsx website/src/components/footer.tsx website/public/llms.txt website/public/llms-full.txt website/public/docs/ai-guide.md test/website-docs.test.ts
git commit -m "docs: add website docs and ai guide"
```

Expected: commit succeeds without staging unrelated work.

## Self-Review

- Spec coverage: Tasks cover `/docs`, landing entry points, public AI assets, repo source docs, focused tests, and website build verification.
- Placeholder scan: No `TBD`, `TODO`, or deferred requirements remain in this plan.
- Type consistency: `DocsPage`, `CodeBlock`, and `CopyButton` names are consistent across route and component tasks.
