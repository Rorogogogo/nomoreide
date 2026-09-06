import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Wrench } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { useResolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  applyTerminalTheme,
  attachWebglRenderer,
  connectWebTerminal,
  createTerminalOutputBuffer,
  createTerminalViewportHandle,
  scheduleTerminalActivation,
  isRecoverableTerminalSpawnError,
  sendWebTerminalControl,
  suppressTerminalColorQuery,
  terminalTheme,
} from "./terminal-runtime";
import {
  DEFAULT_TERMINAL_DISPLAY_SETTINGS,
  INITIAL_STATUS,
  SMOOTH_SCROLL_DURATION_MS,
  TERMINAL_RESIZE_SETTLE_MS,
  WEB_SOCKET_OPEN,
  type DisposableRenderer,
  type StatusUpdate,
  type TerminalControl,
  type TerminalSocketLike,
  type TerminalViewportHandle,
  type TerminalViewportProps,
  type TerminalViewportStatus,
} from "./terminal-types";

// The feature's public module: the component lives here, and the types and
// runtime helpers stay re-exported so importers see one terminal API.
export * from "./terminal-types";
export * from "./terminal-runtime";

/** The terminal element and its lifecycle. The runtime it drives is in `./terminal-runtime`. */

export const TerminalViewport = forwardRef<
  TerminalViewportHandle,
  TerminalViewportProps
>(function TerminalViewport(
  {
    sessionId,
    active,
    focused = active,
    claimInitialInput,
    initialInputIntervalMs,
    onStatusChange,
    displaySettings = DEFAULT_TERMINAL_DISPLAY_SETTINGS,
    interactive = true,
    suppressColorQueries = false,
  },
  forwardedRef,
) {
  const t = useT();
  const resolvedTheme = useResolvedTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRendererRef = useRef<DisposableRenderer | null>(null);
  const socketRef = useRef<TerminalSocketLike | null>(null);
  const statusCallbackRef = useRef(onStatusChange);
  const displaySettingsRef = useRef(displaySettings);
  const interactiveRef = useRef(interactive);
  const activeRef = useRef(active);
  const suppressColorQueriesRef = useRef(suppressColorQueries);
  const statusRef = useRef<TerminalViewportStatus>(INITIAL_STATUS);
  const [status, setStatus] = useState<TerminalViewportStatus>(INITIAL_STATUS);
  const [repairing, setRepairing] = useState(false);
  activeRef.current = active;

  useEffect(() => {
    statusCallbackRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    interactiveRef.current = interactive;
    const terminal = terminalRef.current;
    if (terminal) terminal.options.disableStdin = !interactive;
  }, [interactive]);

  useEffect(() => {
    suppressColorQueriesRef.current = suppressColorQueries;
  }, [suppressColorQueries]);

  const reportStatus = useCallback((update: StatusUpdate) => {
    const next =
      typeof update === "function" ? update(statusRef.current) : update;
    statusRef.current = next;
    setStatus(next);
    if (next.state === "running" || next.state === "error") {
      setRepairing(false);
    }
    statusCallbackRef.current?.(next);
  }, []);

  const sendResize = useCallback(() => {
    // Hidden panes stay mounted for scrollback, but their zero/settling
    // geometry must never resize the shared PTY. Activation schedules the
    // authoritative fit once the pane is visible again.
    if (!interactiveRef.current || !activeRef.current) return;
    const fit = fitRef.current;
    if (!fit) return;
    fit.fit();
    const dimensions = fit.proposeDimensions();
    if (!dimensions) return;
    const socket = socketRef.current;
    if (socket?.readyState !== WEB_SOCKET_OPEN) return;
    socket.send(
      JSON.stringify({
        cols: dimensions.cols,
        rows: dimensions.rows,
        type: "resize",
      }),
    );
  }, []);

  useEffect(() => {
    if (interactive) sendResize();
  }, [interactive, sendResize]);

  useEffect(() => {
    displaySettingsRef.current = displaySettings;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = displaySettings.fontSize;
    terminal.options.cursorStyle = displaySettings.cursorStyle;
    terminal.options.scrollback = displaySettings.scrollback;
    terminal.options.smoothScrollDuration = displaySettings.smoothScroll
      ? SMOOTH_SCROLL_DURATION_MS
      : 0;
    sendResize();
  }, [
    displaySettings.copyOnSelect,
    displaySettings.cursorStyle,
    displaySettings.fontSize,
    displaySettings.scrollback,
    displaySettings.smoothScroll,
    sendResize,
  ]);

  const sendControl = useCallback((type: TerminalControl) => {
    sendWebTerminalControl(socketRef.current, fitRef.current, type);
  }, []);

  const sendInput = useCallback(
    (data: string) => {
      if (!interactiveRef.current) return;
      const socket = socketRef.current;
      if (socket?.readyState !== WEB_SOCKET_OPEN) return;
      socket.send(JSON.stringify({ data, type: "input" }));
    },
    [],
  );

  useImperativeHandle(
    forwardedRef,
    () =>
      createTerminalViewportHandle({
        focus: () => {
          if (interactiveRef.current) terminalRef.current?.focus();
        },
        refit: sendResize,
        sendControl,
        sendInput,
        paste: (data, prefix) => {
          if (!interactiveRef.current) return false;
          const terminal = terminalRef.current;
          if (!terminal) return false;
          if (prefix) sendInput(prefix);
          terminal.paste(data);
          return true;
        },
      }),
    [sendControl, sendInput, sendResize],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: displaySettingsRef.current.cursorStyle,
      // Nerd Font stays ahead of the text face: it carries the powerline and
      // icon glyphs a prompt draws, which JetBrains Mono does not, and a
      // terminal that falls back for those renders boxes through every prompt.
      fontFamily:
        '"Symbols Nerd Font Mono", "IBM Plex Mono", "SF Mono", ui-monospace, Menlo, monospace',
      fontSize: displaySettingsRef.current.fontSize,
      lineHeight: 1.25,
      scrollback: displaySettingsRef.current.scrollback,
      smoothScrollDuration: displaySettingsRef.current.smoothScroll
        ? SMOOTH_SCROLL_DURATION_MS
        : 0,
      disableStdin: !interactiveRef.current,
      theme: terminalTheme(resolvedTheme),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const colorQuerySubscriptions = [10, 11].map((identifier) =>
      terminal.parser.registerOscHandler(
        identifier,
        (data) =>
          suppressColorQueriesRef.current && suppressTerminalColorQuery(data),
      ),
    );
    terminal.open(container);
    const outputBuffer = createTerminalOutputBuffer({
      write: (data) => terminal.write(data),
    });
    const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport) {
      viewport.style.backgroundColor = terminalTheme(resolvedTheme).background;
    }
    terminalRef.current = terminal;
    fitRef.current = fit;
    if (active) {
      webglRendererRef.current = attachWebglRenderer(terminal);
    }
    const selectionSubscription = terminal.onSelectionChange(() => {
      if (!displaySettingsRef.current.copyOnSelect) return;
      const selection = terminal.getSelection();
      if (!selection) return;
      try {
        void navigator.clipboard?.writeText(selection).catch(() => {});
      } catch {
        // Clipboard access can be denied; selection should remain non-fatal.
      }
    });

    const transport = connectWebTerminal({
      claimInitialInput,
      initialInputIntervalMs,
      initialStatus: INITIAL_STATUS,
      reportStatus,
      sendResize,
      sessionId,
      terminal: {
        onData: (callback) => terminal.onData((data) => {
          if (interactiveRef.current) callback(data);
        }),
        write: (data) => outputBuffer.push(data),
      },
    });
    socketRef.current = transport.socket;

    const cleanupTransport = () => {
      transport.dispose();
      socketRef.current = null;
    };

    window.addEventListener("resize", sendResize);
    const initialResizeTimer = window.setTimeout(sendResize, 0);

    let observedResizeTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      if (observedResizeTimer !== undefined) {
        window.clearTimeout(observedResizeTimer);
      }
      observedResizeTimer = window.setTimeout(() => {
        observedResizeTimer = undefined;
        sendResize();
      }, TERMINAL_RESIZE_SETTLE_MS);
    });
    observer.observe(container);

    return () => {
      window.removeEventListener("resize", sendResize);
      window.clearTimeout(initialResizeTimer);
      if (observedResizeTimer !== undefined) {
        window.clearTimeout(observedResizeTimer);
      }
      observer.disconnect();
      cleanupTransport();
      selectionSubscription.dispose();
      colorQuerySubscriptions.forEach((subscription) => {
        subscription.dispose();
      });
      outputBuffer.dispose();
      webglRendererRef.current?.dispose();
      webglRendererRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [reportStatus, sessionId, sendResize]);

  useEffect(() => {
    if (!active) {
      webglRendererRef.current?.dispose();
      webglRendererRef.current = null;
      return;
    }
    if (webglRendererRef.current || !terminalRef.current) return;
    webglRendererRef.current = attachWebglRenderer(terminalRef.current);
  }, [active]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const theme = terminalTheme(resolvedTheme);
    if (terminal) {
      applyTerminalTheme(
        terminal,
        containerRef.current,
        theme,
        webglRendererRef.current,
      );
    }
  }, [resolvedTheme]);

  // A hidden xterm has zero dimensions. Refit after it is revealed, but only
  // the pane the user last interacted with should claim keyboard focus.
  useEffect(() => {
    return scheduleTerminalActivation(active, {
      cancel: (id) => window.clearTimeout(id),
      focus: () => {
        if (focused && interactiveRef.current) terminalRef.current?.focus();
      },
      refit: sendResize,
      schedule: (callback) => window.setTimeout(callback, 0),
    });
  }, [active, focused, sendResize]);

  return (
    <section
      aria-label="terminal viewport"
      className={cn(
        "relative h-full min-h-0 overflow-hidden bg-[#fcfcfc] px-3 py-0.5 dark:bg-[#090909]",
        !active && "hidden",
      )}
      data-terminal-session={sessionId}
    >
      {/* Padding stays outside xterm's mount so FitAddon does not provision an
          extra row and clip the final line. */}
      <div className="h-full w-full" ref={containerRef} />
      {status.state === "error" &&
      isRecoverableTerminalSpawnError(status.detail) ? (
        <div
          className="absolute inset-x-3 top-3 z-20 flex items-start gap-2 border border-destructive/40 bg-background px-3 py-2 text-foreground shadow-sm"
          role="alert"
        >
          <Wrench aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">{t("terminal.repairTitle")}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              {t("terminal.repairBody")}
            </p>
          </div>
          <Button
            className="shrink-0"
            disabled={repairing}
            onClick={() => {
              setRepairing(true);
              sendControl("repair");
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {repairing ? t("terminal.repairing") : t("terminal.repairAction")}
          </Button>
        </div>
      ) : null}
    </section>
  );
});
