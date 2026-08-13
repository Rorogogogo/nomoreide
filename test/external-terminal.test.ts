import net, { type Socket } from "node:net";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, test } from "vitest";
import {
  encodeFrame,
  EXTERNAL_TERMINAL_RESET,
  externalTerminalTitle,
  ExternalTerminalLauncher,
  ghosttyLaunchCommand,
  GHOSTTY_LAUNCH_SCRIPT,
  iTerm2ApplicationPaths,
  ITERM2_LAUNCH_SCRIPT,
  selectExternalTerminal,
  terminalTitleSequence,
  TERMINAL_FRAME,
  TERMINAL_LAUNCH_SCRIPT,
} from "../src/core/external-terminal.js";

class FrameCollector {
  private pending = Buffer.alloc(0);
  private readonly frames: Array<{ kind: number; data: Buffer }> = [];
  private readonly waiters: Array<(frame: { kind: number; data: Buffer }) => void> = [];

  constructor(socket: Socket) {
    socket.on("data", (chunk) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 5) {
        const length = this.pending.readUInt32BE(1);
        if (this.pending.length < 5 + length) break;
        const frame = {
          kind: this.pending[0]!,
          data: this.pending.subarray(5, 5 + length),
        };
        this.pending = this.pending.subarray(5 + length);
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.frames.push(frame);
      }
    });
  }

  next(): Promise<{ kind: number; data: Buffer }> {
    const frame = this.frames.shift();
    return frame ? Promise.resolve(frame) : new Promise((resolve) => this.waiters.push(resolve));
  }
}

describe("external terminal relay", () => {
  test("encodes bounded binary frames", () => {
    const frame = encodeFrame(TERMINAL_FRAME.input, Buffer.from([0, 3, 255]));
    expect(frame[0]).toBe(TERMINAL_FRAME.input);
    expect(frame.readUInt32BE(1)).toBe(3);
    expect([...frame.subarray(5)]).toEqual([0, 3, 255]);
  });

  test("creates one Ghostty window with a safely quoted attach command", () => {
    expect(GHOSTTY_LAUNCH_SCRIPT).toContain("new surface configuration");
    expect(GHOSTTY_LAUNCH_SCRIPT).toContain("from {command:(item 1 of argv)");
    expect(GHOSTTY_LAUNCH_SCRIPT).toContain("new window with configuration configuration");
    expect(GHOSTTY_LAUNCH_SCRIPT).toContain("wait after command:false");
    expect(GHOSTTY_LAUNCH_SCRIPT).not.toContain("open location");

    expect(ghosttyLaunchCommand(
      "/tmp/attach socket.sock",
      "sec'ret",
      "/pkg with spaces/dist/index.js",
    )).toBe(
      `'${process.execPath}' '/pkg with spaces/dist/index.js' __terminal-attach '/tmp/attach socket.sock' 'sec'\\''ret'`,
    );
  });

  test("selects the configured terminal with safe automatic fallbacks", () => {
    expect(selectExternalTerminal("automatic", { ghostty: true, iterm2: true })).toBe("ghostty");
    expect(selectExternalTerminal("automatic", { ghostty: false, iterm2: true })).toBe("iterm2");
    expect(selectExternalTerminal("automatic", { ghostty: false, iterm2: false })).toBe("terminal");
    expect(selectExternalTerminal("terminal", { ghostty: true, iterm2: true })).toBe("terminal");
  });

  test("reports a missing explicitly selected terminal", () => {
    expect(() => selectExternalTerminal("ghostty", { ghostty: false, iterm2: true }))
      .toThrow("Ghostty is not installed");
    expect(() => selectExternalTerminal("iterm2", { ghostty: true, iterm2: false }))
      .toThrow("iTerm2 is not installed");
  });

  test("discovers iTerm2 in system and user Applications folders", () => {
    expect(iTerm2ApplicationPaths("/Users/example")).toEqual([
      "/Applications/iTerm.app",
      "/Users/example/Applications/iTerm.app",
    ]);
  });

  test("starts iTerm2 through a ready login shell", () => {
    expect(ITERM2_LAUNCH_SCRIPT).toContain("create window with default profile");
    expect(ITERM2_LAUNCH_SCRIPT).toContain("delay 1");
    expect(ITERM2_LAUNCH_SCRIPT).toContain("write text (item 1 of argv)");
    expect(ITERM2_LAUNCH_SCRIPT).toContain("set name to (item 2 of argv)");
    expect(ITERM2_LAUNCH_SCRIPT).not.toContain("default profile command");
  });

  test("gives each external tab a safe provider and task identity", () => {
    expect(externalTerminalTitle("codex", "Fix parser")).toBe(
      "🟢 CODEX · Fix parser · NoMoreIDE",
    );
    expect(externalTerminalTitle("claude", "\u001b]2;spoof\u0007  Review API")).toBe(
      "🟠 CLAUDE · ]2;spoof Review API · NoMoreIDE",
    );
    expect(externalTerminalTitle("codex", " ")).toBe(
      "🟢 CODEX · Codex task · NoMoreIDE",
    );
    expect(terminalTitleSequence("🟢 CODEX · Fix parser · NoMoreIDE")).toEqual(
      Buffer.from("\u001b]2;🟢 CODEX · Fix parser · NoMoreIDE\u001b\\"),
    );
    expect(TERMINAL_LAUNCH_SCRIPT).toContain("set custom title of newTab to (item 2 of argv)");
  });

  test.runIf(process.platform === "darwin")(
    "accepts a one-use token, replays output, and forwards input",
    async () => {
      let client: Socket | undefined;
      let frames: FrameCollector | undefined;
      let received = "";
      let detached = false;
      const attached = Promise.withResolvers<void>();
      const launcher = new ExternalTerminalLauncher({
        entryPath: process.execPath,
        preference: () => "iterm2",
        launch: async (socketPath, token, _entryPath, preference, title) => {
          expect(preference).toBe("iterm2");
          expect(title).toBe("🟢 CODEX · Relay test · NoMoreIDE");
          expect((await stat(dirname(socketPath))).mode & 0o777).toBe(0o700);
          expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
          client = net.createConnection(socketPath);
          frames = new FrameCollector(client);
          await new Promise<void>((resolve, reject) => {
            client?.once("connect", resolve);
            client?.once("error", reject);
          });
          client.write(encodeFrame(TERMINAL_FRAME.auth, Buffer.from(token)));
        },
      });

      const relay = await launcher.open({
        attached: () => {
          attached.resolve();
          return Buffer.from("replay");
        },
        input: (data) => { received += data.toString(); },
        resize: () => {},
        detached: () => { detached = true; },
      }, { title: "🟢 CODEX · Relay test · NoMoreIDE" });
      await attached.promise;
      expect((await frames!.next()).kind).toBe(TERMINAL_FRAME.attached);
      expect((await frames!.next())).toEqual({
        kind: TERMINAL_FRAME.output,
        data: EXTERNAL_TERMINAL_RESET,
      });
      expect((await frames!.next())).toEqual({
        kind: TERMINAL_FRAME.output,
        data: Buffer.from("replay"),
      });
      expect((await frames!.next())).toEqual({
        kind: TERMINAL_FRAME.output,
        data: terminalTitleSequence("🟢 CODEX · Relay test · NoMoreIDE"),
      });

      client!.write(encodeFrame(TERMINAL_FRAME.input, Buffer.from("hello")));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(received).toBe("hello");
      relay.revoke();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(detached).toBe(false);
    },
  );
});
