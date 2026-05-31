# NoMoreIDE Documentation and AI Guide Design

Date: 2026-05-31
Domain: website documentation, AI-ingestable docs, repo documentation

## Goal

Create an exhaustive, practical documentation experience for NoMoreIDE that works for both people and AI agents.

The public website will expose a human-friendly documentation page at `https://www.nomoreide.com/docs`. The same documentation will also be available through stable text-first targets that AI agents can fetch directly, including `https://www.nomoreide.com/llms.txt`, `https://www.nomoreide.com/llms-full.txt`, and `https://www.nomoreide.com/docs/ai-guide.md`.

## Current Context

NoMoreIDE is a TypeScript project with:

- A published CLI package named `nomoreide`.
- A local MCP stdio server for AI coding agents.
- A local web dashboard served by the package.
- A separate Vite React landing site under `website/`.
- Existing README coverage for quick start, MCP setup, CLI usage, MCP tools, architecture, safety, development, and licensing.

The landing website is currently a single React application built from `Hero`, `Features`, `HowItWorks`, `CTA`, and `Footer`. It does not use a router yet. The landing page embeds a live mock of the real product and currently links externally to GitHub README documentation.

There are existing unstaged changes in the repository, including website hero changes. Implementation must avoid reverting or rewriting unrelated work.

## Product Decision

Use approach C:

1. Add a polished `/docs` website page for human readers.
2. Add AI-fetchable text documentation files in the website public output.
3. Add source documentation in the repo so future agents and contributors can inspect the docs without depending on the website build.

The landing page should add clear documentation entry points while keeping the existing live product demo behavior unchanged.

## User-Facing Website Behavior

### Route

The website should support:

- `/` for the existing landing page.
- `/docs` for the documentation page.

Because the website is currently a simple Vite SPA, routing can be implemented with a lightweight pathname switch in `website/src/App.tsx` instead of adding a routing dependency. The page should also listen for normal browser navigation behavior where necessary.

### Entry Points

Add visible documentation links without changing the product demo interaction:

- Hero secondary/tertiary action: link to `/docs`.
- CTA "Read the docs": link to `/docs` instead of GitHub README.
- Footer: add or update a "Docs" link to `/docs`.
- Keep "Try the live mock" pointing to the embedded demo section.

### Documentation Page Shape

The `/docs` page should be a structured reference, not a marketing page. It should feel like a serious developer tool manual: dense, scannable, linkable, and easy to search.

Recommended layout:

- Top bar with links back to the landing page, GitHub, and AI docs.
- Left or top table of contents with anchor links.
- Main content column with sections.
- Copyable code blocks where setup commands are shown.
- Compact callout blocks for safety boundaries and AI-agent usage.
- Stable section IDs for deep links.

The design should reuse the existing website visual system: Tailwind CSS 4, existing `Button`, existing tokens, compact rounded corners, and restrained product-tool styling. Avoid adding a heavy design system or a new dependency.

## Required Documentation Content

The `/docs` page and full AI guide should cover:

1. Overview
   - What NoMoreIDE is.
   - Who it is for.
   - The problem it solves: shared local control surface for humans and AI agents.

2. Quick Start
   - `npx -y nomoreide`
   - `npm install -g nomoreide`
   - source checkout build steps.

3. MCP Setup
   - Claude Code command.
   - Codex CLI command.
   - Gemini CLI JSON configuration.
   - Universal prompt users can paste into an agent.
   - Verification with `/mcp`.

4. Running Interfaces
   - MCP server default mode.
   - Terminal UI.
   - Web dashboard.
   - Default local dashboard URL.

5. CLI Reference
   - `setup`
   - `web`
   - `tui`
   - `list`
   - `add service`
   - `add bundle`
   - `start`
   - `stop`
   - `restart`
   - `logs`
   - `git` subcommands.

6. Web Dashboard Guide
   - Services.
   - Logs.
   - Git Review.
   - Error Inbox.
   - Database.
   - Terminal.
   - Agent dock.

7. MCP Tool Reference
   - Service tools.
   - Repo onboarding tools.
   - Git tools.
   - Error tools.
   - Database tools.
   - Agent/UI tools.

8. Configuration Model
   - Config path.
   - Service definitions.
   - Bundle definitions.
   - Git repositories.
   - Database connections.
   - Log sources.

9. Safety Model
   - No arbitrary filesystem scan.
   - Does not kill unmanaged external processes.
   - Reports port conflicts.
   - Git tools omit hard reset, clean, force push, and branch deletion.
   - Database tools are read-only browsing/sample tools.
   - Logs scoped to `.nomoreide/logs/`.

10. AI Agent Guide
    - Recommended setup prompt.
    - Recommended operating prompt for using NoMoreIDE during a coding session.
    - Best practices for agents: list services first, check health before restarting, inspect logs/timeline, use safe Git diff before staging/committing.
    - Suggested tool order for common workflows.

11. Troubleshooting
    - MCP server does not show up.
    - `npx` or Node version problems.
    - Dashboard port conflict.
    - Service will not start.
    - Logs are empty.
    - Git repository is not registered.
    - Database connection fails.

12. Architecture
    - Core layer.
    - MCP server.
    - Web server and route registry.
    - React dashboard.
    - CLI/TUI.
    - Data flow from AI agent to MCP to core managers.

13. Development
    - `npm install`
    - `npm run dev`
    - `npm run dev:web`
    - `npm test`
    - `npm run build`
    - Website build commands.

14. Licensing
    - AGPL-3.0.
    - Commercial licensing pointer.

## AI-Fetchable Documentation

Add stable files in `website/public/` so they are emitted verbatim by the Vite website build:

- `website/public/llms.txt`
  - Short index for AI agents.
  - Explain what NoMoreIDE is.
  - Link to `/llms-full.txt`.
  - Link to `/docs/ai-guide.md`.
  - Link to GitHub and npm.
  - Include the highest-value setup commands.

- `website/public/llms-full.txt`
  - Full plain-text documentation optimized for AI ingestion.
  - Include complete setup, CLI, MCP tools, safety, configuration, troubleshooting, and workflow guidance.
  - Avoid UI-only phrasing that requires visual context.

- `website/public/docs/ai-guide.md`
  - Markdown guide for coding agents.
  - Include prompt blocks and recommended workflows.
  - Use stable headings so agents can fetch and cite specific sections.

Add source equivalents under `docs/`:

- `docs/usage-guide.md`
- `docs/ai-agent-guide.md`

These source files can be mirrored or summarized into the website public files during implementation. To keep the implementation simple and predictable, start with manually maintained Markdown/plain-text files rather than introducing a docs build pipeline.

## Implementation Boundaries

Do not:

- Add a full documentation framework.
- Add a router dependency unless pathname switching becomes insufficient.
- Rewrite the existing landing page visual design.
- Change the live product demo behavior.
- Reformat unrelated source files.
- Revert existing unstaged changes.

Do:

- Keep docs content close to the actual codebase and README.
- Use existing website components and styling.
- Make section headings and anchors stable.
- Prefer plain Markdown/text for AI-fetchable assets.
- Add tests or preflight checks around website routing/docs presence where appropriate.

## Testing Strategy

Run focused verification after implementation:

- `npm --prefix website run build`
- Existing website-related tests if they are already available in the root suite.
- A focused test or static check that confirms the website app links to `/docs` and docs assets exist.

If browser verification is practical, start the website dev server and manually verify:

- `/` still renders the landing page.
- `/docs` renders the docs page.
- `/llms.txt`, `/llms-full.txt`, and `/docs/ai-guide.md` are fetchable.
- The hero, CTA, and footer documentation links navigate correctly.

## Open Decisions Resolved

- Visual companion: declined; proceed text-only.
- Scope: both human docs and AI-fetchable docs.
- Landing behavior: add clear docs entry points; do not change live product demo click behavior.

## Success Criteria

The work is complete when:

- `www.nomoreide.com/docs` has a comprehensive, polished documentation page.
- AI agents can fetch stable documentation from `/llms.txt`, `/llms-full.txt`, and `/docs/ai-guide.md`.
- The repo contains source documentation for future maintenance.
- Landing page documentation links point to `/docs`.
- Existing demo behavior remains intact.
- Website build passes.
