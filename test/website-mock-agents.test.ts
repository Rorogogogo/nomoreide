// @vitest-environment happy-dom

import { beforeAll, describe, expect, test, vi } from "vitest";
import { installWebsiteMockApi } from "../website/src/mock-api";

beforeAll(() => {
  window.fetch = vi.fn(async () => new Response(null, { status: 404 }));
  installWebsiteMockApi();
});

describe("website bottom agent dock mock", () => {
  test("offers configured Claude Code and Codex providers", async () => {
    const response = await window.fetch("/api/agent/chat/status");
    const body = await response.json();

    expect(body.configured).toBe(true);
    expect(body.providers).toMatchObject([
      { id: "claude", label: "Claude Code", configured: true },
      { id: "codex", label: "Codex", configured: true },
    ]);
  });

  test("persists provider selection through the mock endpoint", async () => {
    const response = await window.fetch("/api/agent/chat/provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "codex" }),
    });
    const selected = await response.json();
    const status = await (await window.fetch("/api/agent/chat/status")).json();

    expect(selected.provider.id).toBe("codex");
    expect(status.provider.id).toBe("codex");
  });

  test.each([
    [
      "demo-claude-agent",
      "Claude Code",
      ["Opus 5 with high effort", "❯", "⏺", "Read(", "12 tests passed"],
    ],
    [
      "demo-codex-agent",
      "OpenAI Codex",
      ["╭──", "›", "•", "Explored", "Ran git status", "Context 4% used"],
    ],
  ])("streams a believable %s terminal session", async (id, providerLabel, chrome) => {
    const output = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1/api/terminal/socket?id=${encodeURIComponent(id)}`,
      );
      const timeout = window.setTimeout(
        () => reject(new Error("Mock agent terminal did not emit output.")),
        500,
      );
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 20 }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          data?: string;
          type: string;
        };
        if (message.type !== "output" || !message.data) return;
        window.clearTimeout(timeout);
        socket.close();
        resolve(message.data);
      });
    });

    expect(output).toContain(providerLabel);
    expect(output).toContain("website demo");
    if (id === "demo-claude-agent") {
      expect(output).not.toContain("████");
    }
    for (const fragment of chrome) expect(output).toContain(fragment);
  });

  test("renders follow-up input before provider-specific activity", async () => {
    const output = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(
        "ws://127.0.0.1/api/terminal/socket?id=demo-codex-agent",
      );
      let receivedSeed = false;
      const timeout = window.setTimeout(
        () => reject(new Error("Mock agent follow-up did not emit output.")),
        800,
      );
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 20 }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          data?: string;
          type: string;
        };
        if (message.type !== "output" || !message.data) return;
        if (!receivedSeed) {
          receivedSeed = true;
          socket.send(JSON.stringify({ type: "input", data: "Check the focused test\r" }));
          return;
        }
        window.clearTimeout(timeout);
        socket.close();
        resolve(message.data);
      });
    });

    expect(output.indexOf("›\u001b[0m Check the focused test")).toBeLessThan(
      output.indexOf("•\u001b[0m Explored"),
    );
    expect(output).toContain("Context 6% used");
  });
});
