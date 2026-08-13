import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExternalTerminalPreference } from "./app-settings.js";

export const TERMINAL_FRAME = {
  auth: 1,
  input: 2,
  resize: 3,
  detach: 4,
  output: 101,
  attached: 102,
  revoked: 103,
  error: 104,
} as const;

export const MAX_TERMINAL_FRAME_BYTES = 1024 * 1024;
const MAX_OUTPUT_QUEUE_BYTES = 1024 * 1024;
const AUTH_DEADLINE_MS = 30_000;
const AUTH_READ_TIMEOUT_MS = 500;
const GHOSTTY_APP_PATH = "/Applications/Ghostty.app";
const ITERM2_APP_PATHS = iTerm2ApplicationPaths();
export const EXTERNAL_TERMINAL_RESET = Buffer.from("\u001b[0m\u001b[?25h\u001b[2J\u001b[H");
export const ITERM2_LAUNCH_SCRIPT = [
  "on run argv",
  '  tell application "iTerm2"',
  "    set newWindow to (create window with default profile)",
  // Wait for the login shell to accept input before writing the attach command.
  "    delay 1",
  "    tell current session of newWindow",
  "      set name to (item 2 of argv)",
  "      write text (item 1 of argv)",
  "    end tell",
  "    activate",
  "  end tell",
  "end run",
].join("\n");
export const TERMINAL_LAUNCH_SCRIPT = [
  "on run argv",
  '  tell application "Terminal"',
  "    set newTab to do script (item 1 of argv)",
  "    set custom title of newTab to (item 2 of argv)",
  "    activate",
  "  end tell",
  "end run",
].join("\n");
export const GHOSTTY_LAUNCH_SCRIPT = [
  "on run argv",
  '  tell application "Ghostty"',
  "    set configuration to new surface configuration from {command:(item 1 of argv), wait after command:false}",
  "    set newWindow to new window with configuration configuration",
  "    activate",
  "  end tell",
  "end run",
].join("\n");

export interface ExternalTerminalCallbacks {
  /** Called after authentication. Return replay, or null if the lease is stale. */
  attached(): Buffer | null;
  input(data: Buffer): void;
  resize(cols: number, rows: number): void;
  detached(): void;
}

export interface ExternalTerminalAttachment {
  readonly lease: string;
  sendOutput(data: Buffer): boolean;
  revoke(): void;
}

export interface ExternalTerminalOpenOptions {
  lease?: string;
  title?: string;
}

export interface ExternalTerminalLauncherOptions {
  entryPath: string;
  preference?: () => ExternalTerminalPreference | Promise<ExternalTerminalPreference>;
  launch?: (
    socketPath: string,
    token: string,
    entryPath: string,
    preference: ExternalTerminalPreference,
    title: string,
  ) => Promise<void>;
}

type ExternalTerminalLaunch = NonNullable<
  ExternalTerminalLauncherOptions["launch"]
>;

/**
 * Creates a private, one-use Unix-socket relay and opens the selected terminal
 * with the exact Node executable and installed package entry used by the daemon.
 */
export class ExternalTerminalLauncher {
  private readonly entryPath: string;
  private readonly preference: () => ExternalTerminalPreference | Promise<ExternalTerminalPreference>;
  private readonly launch: ExternalTerminalLaunch;

  constructor(options: ExternalTerminalLauncherOptions) {
    this.entryPath = options.entryPath;
    this.preference = options.preference ?? (() => "automatic");
    this.launch = options.launch ?? launchTerminalApp;
  }

  async open(
    callbacks: ExternalTerminalCallbacks,
    options: ExternalTerminalOpenOptions = {},
  ): Promise<ExternalTerminalAttachment> {
    if (process.platform !== "darwin") {
      throw new Error("External Terminal is currently available on macOS only.");
    }
    const entry = await stat(this.entryPath).catch(() => null);
    if (!entry?.isFile()) {
      throw new Error(`Cannot find the NoMoreIDE entry point at ${this.entryPath}. Build the package first.`);
    }

    const directory = await mkdtemp(join(tmpdir(), "nomoreide-terminal-"));
    await chmod(directory, 0o700);
    const socketPath = join(directory, "attach.sock");
    const token = randomBytes(32).toString("hex");
    const lease = options.lease ?? randomBytes(16).toString("hex");
    const title = sanitizeTerminalTitle(options.title);
    let server: Server | undefined;
    let authenticated: Socket | undefined;
    let finished = false;
    const candidates = new Set<Socket>();

    const cleanup = () => {
      if (finished) return;
      finished = true;
      for (const socket of candidates) socket.destroy();
      candidates.clear();
      server?.close();
      void rm(directory, { force: true, recursive: true });
    };
    const detach = () => {
      cleanup();
      callbacks.detached();
    };

    try {
      server = net.createServer((socket) => {
        if (authenticated || finished) {
          socket.destroy();
          return;
        }
        candidates.add(socket);
        socket.setTimeout(AUTH_READ_TIMEOUT_MS);
        const parser = new FrameParser();
        let authorized = false;
        socket.on("data", (chunk) => {
          try {
            for (const frame of parser.push(chunk)) {
              if (!authorized) {
                if (frame.kind !== TERMINAL_FRAME.auth || !timingSafeToken(frame.data, token)) {
                  writeFrame(socket, TERMINAL_FRAME.error, Buffer.from("Terminal attachment authentication failed"));
                  socket.end();
                  return;
                }
                authorized = true;
                authenticated = socket;
                candidates.delete(socket);
                socket.setTimeout(0);
                server?.close();
                for (const candidate of candidates) candidate.destroy();
                candidates.clear();
                const replay = callbacks.attached();
                if (replay === null) {
                  writeFrame(socket, TERMINAL_FRAME.revoked);
                  socket.end();
                  return;
                }
                writeFrame(socket, TERMINAL_FRAME.attached);
                writeFrame(socket, TERMINAL_FRAME.output, EXTERNAL_TERMINAL_RESET);
                if (replay.length > 0) writeFrame(socket, TERMINAL_FRAME.output, replay);
                if (title) {
                  writeFrame(socket, TERMINAL_FRAME.output, terminalTitleSequence(title));
                }
                continue;
              }
              if (frame.kind === TERMINAL_FRAME.input) callbacks.input(frame.data);
              else if (frame.kind === TERMINAL_FRAME.resize && frame.data.length === 4) {
                const cols = frame.data.readUInt16BE(0);
                const rows = frame.data.readUInt16BE(2);
                if (cols > 0 && rows > 0) callbacks.resize(cols, rows);
              } else if (frame.kind === TERMINAL_FRAME.detach) {
                socket.end();
              }
            }
          } catch {
            socket.destroy();
          }
        });
        socket.on("timeout", () => socket.destroy());
        socket.on("close", () => {
          candidates.delete(socket);
          if (authorized && !finished) detach();
        });
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
      const deadline = setTimeout(() => {
        if (!authenticated && !finished) detach();
      }, AUTH_DEADLINE_MS);
      deadline.unref?.();
      server.once("close", () => clearTimeout(deadline));
      await this.launch(
        socketPath,
        token,
        this.entryPath,
        await this.preference(),
        title,
      );
    } catch (error) {
      cleanup();
      throw error;
    }

    return {
      lease,
      sendOutput(data) {
        const socket = authenticated;
        if (!socket || finished || socket.destroyed) return true;
        const frameBytes = data.length + 5;
        if (data.length > MAX_TERMINAL_FRAME_BYTES || socket.writableLength + frameBytes > MAX_OUTPUT_QUEUE_BYTES) {
          detach();
          return false;
        }
        try {
          writeFrame(socket, TERMINAL_FRAME.output, data);
          return true;
        } catch {
          detach();
          return false;
        }
      },
      revoke() {
        const socket = authenticated;
        if (socket && !socket.destroyed) {
          try {
            writeFrame(socket, TERMINAL_FRAME.revoked);
          } catch {}
          socket.end();
        }
        cleanup();
      },
    };
  }
}

export function encodeFrame(kind: number, data: Buffer = Buffer.alloc(0)): Buffer {
  if (data.length > MAX_TERMINAL_FRAME_BYTES) throw new Error("Terminal frame is too large.");
  const frame = Buffer.allocUnsafe(5 + data.length);
  frame[0] = kind;
  frame.writeUInt32BE(data.length, 1);
  data.copy(frame, 5);
  return frame;
}

function writeFrame(socket: Socket, kind: number, data: Buffer = Buffer.alloc(0)): void {
  socket.write(encodeFrame(kind, data));
}

class FrameParser {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): Array<{ kind: number; data: Buffer }> {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames: Array<{ kind: number; data: Buffer }> = [];
    while (this.pending.length >= 5) {
      const length = this.pending.readUInt32BE(1);
      if (length > MAX_TERMINAL_FRAME_BYTES) throw new Error("Terminal frame is too large.");
      if (this.pending.length < 5 + length) break;
      frames.push({ kind: this.pending[0] ?? 0, data: this.pending.subarray(5, 5 + length) });
      this.pending = this.pending.subarray(5 + length);
    }
    return frames;
  }
}

function timingSafeToken(data: Buffer, token: string): boolean {
  const expected = Buffer.from(token);
  if (data.length !== expected.length) return false;
  return timingSafeEqual(data, expected);
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sanitizeTerminalTitle(value: string | undefined): string {
  if (!value) return "";
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
        ? " "
        : character;
    })
    .join("")
    .trim()
    .split(/\s+/)
    .join(" ");
}

export function externalTerminalTitle(
  provider: string | undefined,
  label: string | undefined,
): string {
  const identity = provider === "codex"
    ? { fallback: "Codex task", marker: "🟢", provider: "CODEX" }
    : provider === "claude"
      ? { fallback: "Claude task", marker: "🟠", provider: "CLAUDE" }
      : { fallback: "Agent task", marker: "🔵", provider: "AGENT" };
  const taskLabel = sanitizeTerminalTitle(label) || identity.fallback;
  return `${identity.marker} ${identity.provider} · ${taskLabel} · NoMoreIDE`;
}

export function terminalTitleSequence(title: string): Buffer {
  return Buffer.from(`\u001b]2;${sanitizeTerminalTitle(title)}\u001b\\`);
}

export type ExternalTerminalApp = Exclude<ExternalTerminalPreference, "automatic">;

export function iTerm2ApplicationPaths(
  homeDirectory = homedir(),
): string[] {
  return [
    "/Applications/iTerm.app",
    join(homeDirectory, "Applications", "iTerm.app"),
  ];
}

export function selectExternalTerminal(
  preference: ExternalTerminalPreference,
  installed: { ghostty: boolean; iterm2: boolean },
): ExternalTerminalApp {
  if (preference === "ghostty" && !installed.ghostty) {
    throw new Error("Ghostty is not installed in /Applications.");
  }
  if (preference === "iterm2" && !installed.iterm2) {
    throw new Error("iTerm2 is not installed in a system or user Applications folder.");
  }
  if (preference !== "automatic") return preference;
  if (installed.ghostty) return "ghostty";
  if (installed.iterm2) return "iterm2";
  return "terminal";
}

async function launchTerminalApp(
  socketPath: string,
  token: string,
  entryPath: string,
  preference: ExternalTerminalPreference,
  title: string,
): Promise<void> {
  const [ghostty, iterm2] = await Promise.all([
    stat(GHOSTTY_APP_PATH).then((entry) => entry.isDirectory()).catch(() => false),
    applicationInstalled(ITERM2_APP_PATHS),
  ]);
  const terminal = selectExternalTerminal(preference, { ghostty, iterm2 });
  if (terminal === "ghostty") return launchGhostty(socketPath, token, entryPath, title);
  if (terminal === "iterm2") return launchITerm2(socketPath, token, entryPath, title);

  const command = `exec ${posixQuote(process.execPath)} ${posixQuote(entryPath)} __terminal-attach ${posixQuote(socketPath)} ${posixQuote(token)}`;
  await launchWithAppleScript(TERMINAL_LAUNCH_SCRIPT, command, title, "Terminal");
}

async function applicationInstalled(paths: string[]): Promise<boolean> {
  const matches = await Promise.all(
    paths.map((path) =>
      stat(path).then((entry) => entry.isDirectory()).catch(() => false)
    ),
  );
  return matches.some(Boolean);
}

async function launchITerm2(socketPath: string, token: string, entryPath: string, title: string): Promise<void> {
  const command = `exec ${posixQuote(process.execPath)} ${posixQuote(entryPath)} __terminal-attach ${posixQuote(socketPath)} ${posixQuote(token)}`;
  await launchWithAppleScript(ITERM2_LAUNCH_SCRIPT, command, title, "iTerm2");
}

async function launchWithAppleScript(
  script: string,
  command: string,
  title: string,
  application: "Ghostty" | "Terminal" | "iTerm2",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", script, "--", command, title], {
      stdio: "ignore",
    });
    child.once("error", () => reject(new Error(`Could not open ${application}.`)));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not open ${application} (osascript exited with ${code ?? "unknown"}).`));
    });
  });
}

export function ghosttyLaunchCommand(
  socketPath: string,
  token: string,
  entryPath: string,
): string {
  return `${posixQuote(process.execPath)} ${posixQuote(entryPath)} __terminal-attach ${posixQuote(socketPath)} ${posixQuote(token)}`;
}

async function launchGhostty(socketPath: string, token: string, entryPath: string, title: string): Promise<void> {
  await launchWithAppleScript(
    GHOSTTY_LAUNCH_SCRIPT,
    ghosttyLaunchCommand(socketPath, token, entryPath),
    title,
    "Ghostty",
  );
}

/** Hidden attach client used by supported terminal apps through the installed entry. */
export async function runExternalTerminalAttach(socketPath: string, token: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("External Terminal is currently available on macOS only.");
  if (!socketPath || !token) throw new Error("Invalid Terminal attachment request.");
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  writeFrame(socket, TERMINAL_FRAME.auth, Buffer.from(token));

  const input = process.stdin;
  const output = process.stdout;
  const parser = new FrameParser();
  let attached = false;
  let settled = false;
  const rawBefore = input.isRaw;
  const sendResize = () => {
    if (!attached || !output.columns || !output.rows) return;
    const size = Buffer.allocUnsafe(4);
    size.writeUInt16BE(Math.min(output.columns, 65_535), 0);
    size.writeUInt16BE(Math.min(output.rows, 65_535), 2);
    writeFrame(socket, TERMINAL_FRAME.resize, size);
  };
  const onInput = (data: Buffer) => writeFrame(socket, TERMINAL_FRAME.input, data);
  const restore = () => {
    input.off("data", onInput);
    process.off("SIGWINCH", sendResize);
    output.off("drain", resumeSocket);
    if (input.isTTY) input.setRawMode(Boolean(rawBefore));
    input.pause();
  };
  const resumeSocket = () => {
    if (!settled) socket.resume();
  };

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      restore();
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.on("data", (chunk) => {
      try {
        for (const frame of parser.push(chunk)) {
          if (frame.kind === TERMINAL_FRAME.attached && !attached) {
            attached = true;
            if (input.isTTY) input.setRawMode(true);
            input.resume();
            input.on("data", onInput);
            process.on("SIGWINCH", sendResize);
            sendResize();
          } else if (frame.kind === TERMINAL_FRAME.output) {
            if (!output.write(frame.data)) {
              socket.pause();
              output.once("drain", resumeSocket);
            }
          } else if (frame.kind === TERMINAL_FRAME.revoked) {
            finish();
          } else if (frame.kind === TERMINAL_FRAME.error) {
            finish(new Error(frame.data.toString("utf8")));
          }
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("end", () => finish());
    socket.once("close", () => finish());
    socket.once("error", (error) => finish(error));
  });
}
