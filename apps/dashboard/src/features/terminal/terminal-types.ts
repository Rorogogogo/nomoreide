import type { Terminal } from "@xterm/xterm";
import { translate } from "@/lib/i18n";

/**
 * The shapes the terminal's runtime and its component both speak.
 *
 * Split out so `terminal-runtime.ts` (the xterm/WebSocket plumbing) and
 * `terminal-viewport.tsx` (the React component that drives it) can each import
 * them without importing each other.
 *
 * The `*Like` interfaces are deliberately structural: the runtime is unit
 * tested against plain objects, so it must not require a real `WebSocket` or a
 * real `FitAddon`.
 */

export type TerminalConnectionState =
  | "connecting"
  | "running"
  | "exited"
  | "error";

export interface TerminalViewportStatus {
  state: TerminalConnectionState;
  cwd: string;
  detail: string;
}

export interface TerminalViewportHandle {
  repair(): void;
  restart(): void;
  stop(): void;
  focus(): void;
  refit(): void;
  /** Writes raw data to the PTY, as if typed into the terminal. */
  input(data: string): void;
  /** Pastes text using xterm's bracketed-paste handling. */
  paste(data: string, prefix?: string): boolean;
}

export interface TerminalViewportProps {
  /** Server session id this viewport attaches to. */
  sessionId: string;
  /** Hidden viewports remain mounted to preserve their PTY and scrollback. */
  active: boolean;
  /** Only the focused visible pane should claim keyboard focus. */
  focused?: boolean;
  /** Reports transport status for optional chrome rendered by a parent. */
  onStatusChange?: (status: TerminalViewportStatus) => void;
  /** Claims one-time inputs after the PTY has finished its startup output. */
  claimInitialInput?: () => readonly string[] | undefined;
  /** Delay between composed initial input and its submit key. */
  initialInputIntervalMs?: number;
  /** Confirmed display preferences; optional for isolated consumers/tests. */
  displaySettings?: TerminalDisplaySettings;
  /** False keeps output mirrored while another surface owns input and resize. */
  interactive?: boolean;
  /** Prevents a child TUI from caching the host palette at process startup. */
  suppressColorQueries?: boolean;
}

export interface TerminalDisplaySettings {
  fontSize: number;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  copyOnSelect: boolean;
  smoothScroll: boolean;
}

export const DEFAULT_TERMINAL_DISPLAY_SETTINGS: TerminalDisplaySettings = {
  fontSize: 13,
  cursorStyle: "block",
  scrollback: 5_000,
  copyOnSelect: false,
  smoothScroll: true,
};

/**
 * How long xterm animates a wheel scroll. Its default of 0 teleports the
 * viewport a whole line per notch, which reads as dropped frames on a trackpad
 * that emits many small deltas. Only affects buffers with scrollback — a
 * full-screen TUI (Claude Code runs in the alternate screen; Codex does not,
 * see `--no-alt-screen`) handles its own scrolling and is unaffected.
 */
export const SMOOTH_SCROLL_DURATION_MS = 120;

export type StatusUpdate =
  | TerminalViewportStatus
  | ((current: TerminalViewportStatus) => TerminalViewportStatus);

export interface TerminalSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ): void;
}

export interface FitDimensionsLike {
  proposeDimensions(): { cols: number; rows: number } | undefined;
}

export type TerminalControl = "repair" | "restart" | "stop";

export type ServerMessage =
  | {
      cols?: number;
      cwd?: string;
      error?: string;
      rows?: number;
      shell?: string;
      state: TerminalConnectionState | "idle";
      type: "state";
    }
  | { data: string; type: "output" }
  | { error: string; type: "error" };

export const INITIAL_STATUS: TerminalViewportStatus = {
  state: "connecting",
  cwd: translate("terminal.localWorkspace"),
  detail: translate("terminal.openingShell"),
};
export const WEB_SOCKET_OPEN = 1;
export const OUTPUT_BATCH_DELAY_MS = 8;
// Layout transitions (notably the hover-expanded navigation rail) can emit a
// ResizeObserver entry every animation frame. Forwarding every intermediate
// width to the PTY makes interactive shells redraw their prompts repeatedly.
// Wait for a short quiet period and resize once at the settled dimensions.
export const TERMINAL_RESIZE_SETTLE_MS = 80;

export interface DisposableRenderer {
  dispose(): void;
  clearTextureAtlas?(): void;
}

export interface ThemeableTerminal {
  options: Terminal["options"];
  refresh(start: number, end: number): void;
  rows: number;
}

/**
 * Palette assignment alone is not enough for every renderer. In particular,
 * WebGL can retain cells drawn with the previous default foreground/background,
 * which leaves Codex's full-width composer and tool rows as light blocks after
 * a light-to-dark switch. Invalidate both the glyph atlas and visible rows so
 * existing terminal content is repainted against the new palette immediately.
 */