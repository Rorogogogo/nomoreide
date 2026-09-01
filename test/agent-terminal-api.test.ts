import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { httpTerminalApi } from "../apps/dashboard/src/lib/api/terminal-http.js";

const apiDir = resolve(__dirname, "../apps/dashboard/src/lib/api");
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
    expect(contractSource).toMatch(/oneTimeSkill\?:\s*OneTimeSkillSelection/);
    expect(contractSource).toMatch(/resumeId\?:\s*string/);
    expect(contractSource).toContain("listAgentTranscripts(scope?: AgentTranscriptScope)");
    expect(contractSource).toMatch(/kind\?:\s*"shell"\s*\|\s*"service"\s*\|\s*"agent"/);
    expect(contractSource).toMatch(/provider\?:\s*"claude"\s*\|\s*"codex"/);
    expect(contractSource).toContain(
      "createAgentTerminalSession(opts: CreateAgentTerminalOptions): Promise<TerminalSessionInfo>",
    );
    expect(contractSource).toContain(
      "renameTerminalSession(id: string, label: string): Promise<TerminalSessionInfo>",
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

  test("HTTP creation carries one temporary skill as typed metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        session: {
          id: "agent-skill",
          cwd: "/repo",
          cols: 100,
          rows: 28,
          shell: "codex",
          state: "running",
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await httpTerminalApi.createAgentTerminalSession({
      provider: "codex",
      prompt: "Find a useful skill",
      oneTimeSkill: {
        name: "find-skills",
        source: "vercel-labs/skills@find-skills",
      },
    });

    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      agent: {
        provider: "codex",
        prompt: "Find a useful skill",
        oneTimeSkill: {
          name: "find-skills",
          source: "vercel-labs/skills@find-skills",
        },
      },
    });
  });

  test("HTTP lists transcripts and sends resume ids through agent creation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, transcripts: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            session: {
              id: "agent-2",
              cwd: "/repo",
              cols: 100,
              rows: 28,
              shell: "codex",
              state: "running",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);

    await httpTerminalApi.listAgentTranscripts();
    await httpTerminalApi.createAgentTerminalSession({
      provider: "codex",
      prompt: "",
      resumeId: "dce2b69c-0fb4-4bd3-b456-b2bef4230c81",
    });

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/terminal/transcripts", undefined);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({
      agent: {
        provider: "codex",
        prompt: "",
        resumeId: "dce2b69c-0fb4-4bd3-b456-b2bef4230c81",
      },
    });
  });

  test("HTTP rename patches the encoded session id and returns the session", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          session: {
            id: "agent/1",
            cwd: "/repo",
            cols: 100,
            rows: 28,
            shell: "codex",
            state: "running",
            label: "Review tests",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const renamed = await httpTerminalApi.renameTerminalSession(
      "agent/1",
      "Review tests",
    );

    expect(renamed.label).toBe("Review tests");
    expect(fetch).toHaveBeenCalledWith("/api/terminal/sessions/agent%2F1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Review tests" }),
    });
  });

  test("Tauri delegates a nested typed agent request through the bridge", () => {
    expect(tauriSource).toContain("createAgentTerminalSession");
    expect(tauriSource).toContain("listAgentTranscripts");
    expect(tauriSource).toMatch(/tauri_createTerminalSession\(\{\s*agent:\s*opts\s*\}\)/);
    expect(bridgeSource).toContain("agent?: CreateAgentTerminalOptions");
    expect(bridgeSource).toMatch(/agent:\s*opts\?\.agent\s*\?\?\s*null/);
    expect(tauriSource).toContain("tauri_renameTerminalSession");
    expect(bridgeSource).toContain('"rename_terminal_session"');
  });

  test("Tauri list and create adapters preserve agent labels", () => {
    const labelFallbacks = bridgeSource.match(
      /label:\s*session\.label\s*\?\?\s*session\.serviceName\s*\?\?\s*undefined/g,
    );

    expect(labelFallbacks).toHaveLength(3);
  });

  test("the terminal entry point exports and dispatches agent creation", () => {
    expect(terminalSource).toContain("export function createAgentTerminalSession");
    expect(terminalSource).toContain("httpTerminalApi.createAgentTerminalSession(opts)");
    expect(terminalSource).toContain("httpTerminalApi.renameTerminalSession(id, label)");
    expect(terminalSource).toContain("CreateAgentTerminalOptions");
  });

  test("desktop sessions expose external Terminal presentation and lifecycle actions", async () => {
    expect(contractSource).toContain('"dock" | "terminalLaunching" | "terminal"');
    expect(contractSource).toContain("openTerminalInSystemTerminal(id: string)");
    expect(contractSource).toContain("reclaimTerminalToDock(id: string)");
    expect(contractSource).toContain("insertAgentPrompt(id: string, prompt: string)");
    expect(tauriSource).toContain("tauri_openTerminalInSystemTerminal");
    expect(tauriSource).toContain("tauri_reclaimTerminalToDock");
    expect(tauriSource).toContain("tauri_insertAgentPrompt");
    expect(bridgeSource).toContain('"open_terminal_in_system_terminal"');
    expect(bridgeSource).toContain('"reclaim_terminal_to_dock"');
    expect(bridgeSource).toContain('"insert_agent_prompt"');
    expect(bridgeSource).toContain('"terminal-session-changed"');

    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ externalTerminal: true }))
      .mockResolvedValueOnce(Response.json({
        ok: true,
        session: { id: "agent-1", presentation: "terminal" },
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(httpTerminalApi.getTerminalCapabilities()).resolves.toEqual({
      externalTerminal: true,
    });
    await expect(httpTerminalApi.openTerminalInSystemTerminal("agent-1")).resolves.toMatchObject({
      id: "agent-1",
      presentation: "terminal",
    });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/terminal/capabilities", undefined);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/terminal/sessions/agent-1/open-system-terminal",
      {
        method: "POST",
        headers: { "x-nomoreide-terminal-control": "1" },
      },
    );
  });

  test("HTTP prompt insertion uses the guarded endpoint and preserves the draft payload", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);

    await httpTerminalApi.insertAgentPrompt("agent/1", "Review this\nwithout submitting");

    expect(fetch).toHaveBeenCalledWith(
      "/api/terminal/sessions/agent%2F1/insert-prompt",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nomoreide-terminal-control": "1",
        },
        body: JSON.stringify({ prompt: "Review this\nwithout submitting" }),
      },
    );
    expect(terminalSource).toContain("httpTerminalApi.insertAgentPrompt(id, prompt)");
  });
});
