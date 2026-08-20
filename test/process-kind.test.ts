import { describe, expect, test } from "vitest";
import { processKindForCommand } from "../apps/dashboard/src/features/services/process-kind.js";

describe("processKindForCommand", () => {
  test.each([
    ["npm run dev -- --host 0.0.0.0", "npm"],
    ["pnpm dev", "pnpm"],
    ["pnpm vite --host 0.0.0.0", "vite"],
    ["yarn dev", "yarn"],
    ["cargo run -p api --bin api", "cargo"],
    ["rustc main.rs", "rust"],
    ["dotnet watch run", "dotnet"],
    ["python3 -m uvicorn app:app", "python"],
    ["go run ./cmd/server", "go"],
    ["docker compose up api", "docker"],
    ["bun run dev", "bun"],
    ["deno task start", "deno"],
    ["./server", "generic"],
  ])("detects %s", (command, kind) => {
    expect(processKindForCommand(command).kind).toBe(kind);
  });
});
