# Repository layout cleanup

**Status:** Planning only. No implementation is authorized by this document.

**Relationship to the Rust migration:** this lands as PR 2 of `2026-08-20-native-rust-runtime-and-mcp.md`, after the contract snapshot and before the Cargo workspace, so the new crates arrive in their final home instead of being moved twice.

## The problem

The tree currently has five directories named `src`, and nothing in the name distinguishes them:

```text
src/                    Node runtime: CLI, TUI, MCP, core, HTTP routes
src/web/client/src/     the React dashboard — a src inside a src inside a src
src-tauri/src/          desktop Rust
website/src/            marketing site (separate npm project)
video/src/              Remotion project (gitignored; not part of the repo)
```

That is the visible symptom. The structural cause is that **one directory and one manifest serve two different runtimes**, which produces four concrete costs.

### 1. The published npm package ships the whole frontend toolchain as runtime dependencies

`package.json` declares 41 `dependencies`. Roughly thirty of them — `react`, `react-dom`, `framer-motion`, `@xterm/*`, `codemirror`, `@codemirror/*`, `lucide-react`, `@xyflow/react`, `highlight.js`, `marked`, `simple-icons`, `tailwindcss`, `vite` — are used **only** under `src/web/client` and are compiled away by Vite into `dist/web/client`. Verified: no file outside `src/web/client` imports any of them.

They are nonetheless installed by `npm i -g nomoreide`, for a CLI that ships nothing but prebuilt assets.

### 2. Root config files reach three directories deep

`vite.config.ts` sets `root: "src/web/client"` and `outDir: "../../../dist/web/client"`. The same file also configures Vitest for the *server* test suite. `components.json` (shadcn) sits at the root while every component it governs lives under `src/web/client/src`.

### 3. The website hand-maintains a dependency bridge

`website/vite.config.ts` aliases `@` to `../src/web/client/src` and then re-aliases **35 packages** back into `website/node_modules` to avoid duplicate React instances, backed by a bespoke `website/scripts/verify-shared-deps.mjs` guard. This is what sharing source across two non-workspace npm projects costs. A real workspace dependency replaces the alias table, the dedupe list, and the verification script.

### 4. `CLAUDE.md` has to explain the layout

The client is excluded from the server `tsconfig.json`, so CI runs a separate `npx tsc -p src/web/client/tsconfig.json --noEmit` step, which the documentation has to call out explicitly. Directory boundaries that need prose are boundaries in the wrong place.

## Target layout

```text
nomoreide/
├── apps/
│   ├── dashboard/          ← src/web/client       React SPA; survives the migration
│   │   ├── package.json    browser dependencies only
│   │   ├── vite.config.ts  local paths, no ../../../
│   │   ├── tsconfig.json
│   │   ├── index.html
│   │   └── src/
│   └── website/            ← website/             depends on dashboard as a workspace
├── crates/
│   ├── nomoreide-core/     ← src-tauri/src/core
│   ├── nomoreide-daemon/
│   ├── nomoreide-client/
│   ├── nomoreide-mcp/
│   ├── nomoreide-cli/
│   └── nomoreide-tauri/    ← src-tauri
├── src/                    Node runtime; unchanged, removed at Phase 8
├── docs/
├── test/
├── Cargo.toml              Rust workspace
├── vitest.config.ts        server test suite, split out of vite.config.ts
└── package.json            npm workspaces root; server dependencies only
```

Every remaining `src` then belongs to exactly one package and is named by its parent.

## What moves, and what deliberately does not

### Move: `src/web/client` → `apps/dashboard`

This is the highest-value move and the only frontend directory that **survives** the Rust migration (decision 5, and Phase 8 keeps the React source and build pipeline). It gains its own `package.json`, `vite.config.ts`, and `components.json`; the root manifest keeps only server dependencies; the root `vite.config.ts` becomes `vitest.config.ts`.

Blast radius: `@/*` imports are unchanged because the alias moves with the package. Touched files are the two Vite configs, two `tsconfig.json` files, `components.json`, `package.json`, `.github/workflows/ci.yml:48`, and the `dist/web/client` output path consumed by `static-assets.ts`.

### Move: `website` → `apps/website`

Becomes a workspace sibling that depends on `@nomoreide/dashboard`. Deletes the 35-entry alias table, the `dedupe` list, and `verify-shared-deps.mjs`.

### Move: `src-tauri` → `crates/nomoreide-tauri`

Happens with the Cargo workspace in Phase 1. Touches `.github/workflows/ci.yml:79,84`, `desktop-release.yml:51`, `deploy.yml:57`, `tauri.conf.json`, and `scripts/sync-version.mjs`.

### Move: loose root documents into `docs/`

`DESIGN.md`, `IDEAS.md`, `I18N_HANDOFF.md`, and `handoffs/` move under `docs/`. `README.md`, `LICENSE`, `COMMERCIAL.md`, `CLAUDE.md`, and `AGENTS.md` stay at the root, where their tooling and conventions expect them.

### Do not move: `src/`

Renaming it to something honest like `node-runtime/` is tempting and should be **declined for now**. It is 648 tracked files and 236 test files importing `../src/...`, all for a directory that Phase 8 deletes outright. Once the dashboard moves out, `src/` is unambiguous by subtraction: it is the Node runtime being replaced.

If a marker is still wanted, rename it to `legacy/` during Phase 7, when TypeScript formally becomes the fallback path rather than the shipped one.

### Do not move: `test/`

Vitest covers both server and client tests from one root config today. Splitting tests per package is a defensible end state but it is not what makes the tree confusing, and it would collide with the parity harness landing in Phase 0.

## Sequencing

1. **Dashboard extraction.** Move to `apps/dashboard`, split `package.json`, split `vite.config.ts` into `apps/dashboard/vite.config.ts` plus a root `vitest.config.ts`, update CI. Gate: `npm run build`, `npm test`, `npm run lint`, the client typecheck, and a daemon serving the built client all pass.
2. **Website as a workspace.** Move to `apps/website`, declare the dashboard dependency, delete the alias table and `verify-shared-deps.mjs`. Gate: `npm --prefix apps/website run build` and the embedded `WorkbenchApp` renders with one React instance.
3. **Document moves.** Pure `git mv` plus link fixes in `CLAUDE.md` and `README.md`.
4. **Crates.** Folded into Phase 1 of the Rust migration, not done separately.

Steps 1 and 2 are behaviour-neutral and independently revertable. Neither blocks Phase 0.

## Risks

- **Parallel writers.** This tree has concurrent writers; a large `git mv` set will conflict with in-flight work. Land each step as its own short-lived PR, never batched.
- **`dist/` layout is a public contract.** `static-assets.ts` and the daemon both resolve `dist/web/client`. Keep that output path identical across the move, even though the source path changes.
- **npm workspaces and the published package.** `package.json` `files` currently ships `dist`, `profiles/nomoreide-debug`, and `README.md`. Confirm the workspace root still publishes exactly that set and no workspace member leaks into the tarball.
- **Version sync.** `scripts/sync-version.mjs` writes `package.json`, `tauri.conf.json`, and `Cargo.toml`. It must learn the new paths in the same PR that moves them, or `deploy.yml` breaks at release time rather than in CI.
