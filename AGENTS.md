# Repository Guidelines

## Project Structure & Module Organization

NoMoreIDE is a Node.js 20+ TypeScript application with React and Tauri surfaces.

- `src/core/` contains process, Git, database, agent, and configuration logic.
- `src/cli/`, `src/mcp/`, `src/web/routes/`, and `src/tui/` expose that logic through the CLI, MCP server, HTTP API, and terminal UI.
- `src/web/client/` is the Vite/React dashboard; keep reusable UI in `components/`, domain behavior in `features/`, and transport adapters in `lib/api/`.
- `test/` contains the Vitest suite. Tests generally mirror source behavior rather than directory layout.
- `src-tauri/` contains the Rust desktop shell. `website/`, `video/`, and `assets/` hold the public site, Remotion media, and shared artwork.
- Generated output belongs in `dist/`, `website/dist/`, or `video/out/` and should not be hand-edited.

## Build, Test, and Development Commands

- `npm ci`: install the lockfile-pinned dependencies.
- `npm run dev`: run the TypeScript CLI/server directly with `tsx`.
- `npm run dev:web`: start the dashboard at `127.0.0.1:5173`; its API proxy expects the backend on port `4317`.
- `npm run build`: build the React client and compile server TypeScript into `dist/`.
- `npm test`: run all Vitest tests once.
- `npm run lint`: check `src/**/*.ts(x)` with Biome.
- `npm run tauri:dev`: launch the desktop application for local testing.

## Coding Style & Naming Conventions

Follow existing TypeScript: strict types, two-space indentation, double quotes, semicolons, and `.js` extensions in relative imports. Use `kebab-case.ts`/`.tsx` filenames, `PascalCase` for components and classes, `camelCase` for functions, and `UPPER_SNAKE_CASE` for constants. Prefer small vertical slices over adding responsibilities to broad “god” modules. Biome linting is authoritative; formatting is intentionally not automated.

## Testing Guidelines

Use Vitest (`describe`, `test`, `expect`) and name files `test/<behavior>.test.ts` or `.test.tsx`. Add focused regression tests for fixes and cover success, validation, and safety boundaries. Use Happy DOM for component behavior where applicable. Before submitting, run `npm run lint`, `npm test`, and `npm run build`; CI verifies builds and tests on Node 20, 22, and 24.

## Commit & Pull Request Guidelines

Recent history favors Conventional Commit subjects such as `feat(dock): ...`, `fix(client): ...`, `test: ...`, and `docs: ...`; include an issue key when available. PRs should explain motivation, link issues, identify the change type, and list test commands or manual checks. Include screenshots for visible UI changes. Confirm the PR remains a coherent vertical slice, preserves guarded Git/database write paths, updates relevant docs, and contains no credentials.
