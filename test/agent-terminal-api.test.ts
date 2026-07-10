import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { httpTerminalApi } from "../src/web/client/src/lib/api/terminal-http.js";

const apiDir = resolve(__dirname, "../src/web/client/src/lib/api");
const contractSource = readFileSync(resolve(apiDir, "terminal-api.ts"), "utf8");
const tauriSource = readFileSync(resolve(apiDir, "terminal-tauri.ts"), "utf8");
const bridgeSource = readFileSync(resolve(apiDir, "tauri-bridge.ts"), "utf8");
const terminalSource = readFileSync(resolve(apiDir, "terminal.ts"), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent terminal client API", () => {
  test("declares the agent creation options and session metadata", () => {
    expect(contractSource).toContain("export interface CreateAgentTerminalOptions");
    expect(contractSource).toMatch(/provider:\s*"claude"\s*\|\s*"codex"/);
    expect(contractSource).toMatch(/prompt:\s*string/);
    expect(contractSource).toMatch(/label\?:\s*string/);
    expect(contractSource).toMatch(/kind\?:\s*"shell"\s*\|\s*"service"\s*\|\s*"agent"/);
    expect(contractSource).toMatch(/provider\?:\s*"claude"\s*\|\s*"codex"/);
    expect(contractSource).toContain(
      "createAgentTerminalSession(opts: CreateAgentTerminalOptions): Promise<TerminalSessionInfo>",
    );
  });

  test("HTTP creation serializes the agent request under the agent key", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          session: {
            id: "agent-1",
            cwd: "/repo",
            cols: 100,
            rows: 28,
            shell: "claude",
            state: "running",
            kind: "agent",
            provider: "claude",
            label: "Diagnose API",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    await httpTerminalApi.createAgentTerminalSession({
      provider: "claude",
      prompt: "Diagnose the API service",
      label: "Diagnose API",
    });

    expect(fetch).toHaveBeenCalledWith("/api/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: {
          provider: "claude",
          prompt: "Diagnose the API service",
          label: "Diagnose API",
        },
      }),
    });
  });

  test("Tauri delegates a nested typed agent request through the bridge", () => {
    expect(tauriSource).toContain("createAgentTerminalSession");
    expect(tauriSource).toMatch(/tauri_createTerminalSession\(\{\s*agent:\s*opts\s*\}\)/);
    expect(bridgeSource).toContain("agent?: CreateAgentTerminalOptions");
    expect(bridgeSource).toMatch(/agent:\s*opts\?\.agent\s*\?\?\s*null/);
  });

  test("the terminal entry point exports and dispatches agent creation", () => {
    expect(terminalSource).toContain("export function createAgentTerminalSession");
    expect(terminalSource).toContain("terminalApi().createAgentTerminalSession(opts)");
    expect(terminalSource).toContain("CreateAgentTerminalOptions");
  });
});
