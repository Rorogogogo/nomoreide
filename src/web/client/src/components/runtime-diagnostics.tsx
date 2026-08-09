import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  CheckCircle2,
  Copy,
  RefreshCw,
  ServerOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import {
  formatRuntimeDiagnostics,
  getRuntimeConnectionSnapshot,
  probeRuntimeHealth,
  useRuntimeConnection,
} from "@/lib/runtime-connection";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const HEALTHY_POLL_MS = 5_000;
const FIRST_RETRY_MS = 1_000;
const RECOVERED_VISIBLE_MS = 2_500;
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function runtimeApiTarget(
  location: Pick<Location, "origin"> = window.location,
  development = import.meta.env.DEV,
): string {
  return development ? "http://127.0.0.1:4317" : location.origin;
}

export function runtimeRestartCommand(
  apiTarget: string,
  source = false,
): string {
  const base = source
    ? "node dist/index.js daemon restart"
    : "nomoreide daemon restart";
  try {
    const port = new URL(apiTarget).port;
    return port && port !== "4317" ? `${base} --port=${port}` : base;
  } catch {
    return base;
  }
}

export function runtimeDiagnosticsMockEnabled(
  search: string,
  development = import.meta.env.DEV,
): boolean {
  return (
    development &&
    new URLSearchParams(search).get("mockBackendDown") === "1"
  );
}

function displayTime(value: number | null): string {
  if (value === null) return "—";
  return TIME_FORMATTER.format(value);
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 px-3 py-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words font-mono text-foreground">{value}</span>
    </div>
  );
}

export function RuntimeDiagnostics({
  autoProbe = true,
  healthProbe = probeRuntimeHealth,
  onReconnect,
}: {
  /** Injectable seams keep isolated render tests deterministic. */
  autoProbe?: boolean;
  healthProbe?: typeof probeRuntimeHealth;
  onReconnect: () => void | Promise<void>;
}) {
  const t = useT();
  const actualCurrent = useRuntimeConnection();
  const mockEnabled = runtimeDiagnosticsMockEnabled(window.location.search);
  const [mockStartedAt] = useState(() => Date.now());
  const current = mockEnabled
    ? {
        ...actualCurrent,
        phase: "unreachable" as const,
        consecutiveFailures: 2,
        lastFailureAt: mockStartedAt,
        lastFailedEndpoint: "GET /api/health",
        lastError: "Failed to fetch (mock preview)",
        recoveredAt: null,
      }
    : actualCurrent;
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [copied, setCopied] = useState<"diagnostics" | "restart" | "source" | null>(null);
  const [showRecovered, setShowRecovered] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef(false);

  const runProbe = useCallback(
    async (manual: boolean) => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      if (manual) setRetrying(true);
      const wasUnavailable =
        getRuntimeConnectionSnapshot().phase === "unreachable";
      try {
        const ok = await healthProbe();
        if (ok && (manual || wasUnavailable)) await onReconnect();
        return ok;
      } finally {
        inFlightRef.current = false;
        if (manual) setRetrying(false);
      }
    },
    [healthProbe, onReconnect],
  );

  useEffect(() => {
    if (isTauri() || !autoProbe || mockEnabled) return;
    if (
      current.phase !== "reconnecting" &&
      current.phase !== "unreachable"
    ) {
      return;
    }
    const delay =
      current.phase === "reconnecting" && current.consecutiveFailures === 1
        ? FIRST_RETRY_MS
        : HEALTHY_POLL_MS;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible") void runProbe(false);
    }, delay);
    const checkNow = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void runProbe(false);
    };

    window.addEventListener("focus", checkNow);
    window.addEventListener("online", checkNow);
    document.addEventListener("visibilitychange", checkNow);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", checkNow);
      window.removeEventListener("online", checkNow);
      document.removeEventListener("visibilitychange", checkNow);
    };
  }, [autoProbe, current.consecutiveFailures, current.phase, mockEnabled, runProbe]);

  useEffect(() => {
    if (current.recoveredAt === null) return;
    setShowRecovered(true);
    const timer = window.setTimeout(
      () => setShowRecovered(false),
      RECOVERED_VISIBLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [current.recoveredAt]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("mousedown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  if (isTauri()) return null;
  const unreachable = current.phase === "unreachable";
  const recoveredRecently =
    current.recoveredAt !== null &&
    Date.now() - current.recoveredAt < RECOVERED_VISIBLE_MS;
  const recoveryVisible = showRecovered || recoveredRecently;
  if (!unreachable && !recoveryVisible && !open) return null;

  const apiTarget = runtimeApiTarget();
  const restartCommand = runtimeRestartCommand(apiTarget);
  const sourceRestartCommand = runtimeRestartCommand(apiTarget, true);
  const recovered = !unreachable;
  const label = recovered
    ? t("runtimeDiagnostics.restored")
    : t("runtimeDiagnostics.unreachable");
  const copyText = async (
    kind: "diagnostics" | "restart" | "source",
    value: string,
  ) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_500);
    } catch {
      setCopied(null);
    }
  };
  const diagnostics = formatRuntimeDiagnostics(current, {
    apiTarget,
    browserOnline: navigator.onLine,
    frontendVersion: __APP_VERSION__,
  });

  return (
    <div className="relative flex items-center">
      <Tooltip align="end" disabled={open} label={label}>
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t("runtimeDiagnostics.open", { state: label })}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            recovered
              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
              : "border-red-500/40 bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300",
          )}
          onClick={() => setOpen((value) => !value)}
          ref={triggerRef}
          type="button"
        >
          {recovered ? (
            <CheckCircle2 aria-hidden="true" className="size-3.5" />
          ) : (
            <ServerOff aria-hidden="true" className="size-3.5" />
          )}
          <span>{label}</span>
          {!recovered ? (
            <span className="size-1.5 rounded-full bg-red-500 animate-pulse motion-reduce:animate-none" />
          ) : null}
        </button>
      </Tooltip>

      {open
        ? createPortal(
            // biome-ignore lint/a11y/noStaticElementInteractions: this zero-layout portal boundary keeps the scoped menu from bubbling into the workspace menu.
            <div
              onContextMenu={(event) => event.stopPropagation()}
              role="presentation"
            >
              <ContextMenu modal={false}>
                <ContextMenuTrigger asChild>
                  <aside
                    aria-label={t("runtimeDiagnostics.title")}
                    className="fixed bottom-0 right-0 top-0 z-[90] flex w-[380px] max-w-[calc(100vw-1rem)] flex-col border-l border-border bg-card shadow-xl"
                    ref={panelRef}
                    role="dialog"
                  >
              <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
                <div className="flex items-center gap-2">
                  <ServerOff aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  <h2 className="text-xs font-semibold">{t("runtimeDiagnostics.title")}</h2>
                  {mockEnabled ? (
                    <span className="border border-amber-500/40 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                      {t("runtimeDiagnostics.mockPreview")}
                    </span>
                  ) : null}
                </div>
                <button
                  aria-label={t("common.close")}
                  className="grid size-6 place-items-center text-muted-foreground hover:text-foreground"
                  onClick={() => setOpen(false)}
                  type="button"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </div>

              <div className="border-b border-border px-3 py-3">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      recovered ? "bg-emerald-500" : "bg-red-500",
                    )}
                  />
                  <span className="text-xs font-medium">{label}</span>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  {recovered
                    ? t("runtimeDiagnostics.restoredBody")
                    : t("runtimeDiagnostics.unreachableBody")}
                </p>
              </div>

              <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
                <section>
                  <div className="px-3 pb-1 pt-3 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t("runtimeDiagnostics.connection")}
                  </div>
                  <DetailRow label={t("runtimeDiagnostics.apiTarget")} value={apiTarget} />
                  <DetailRow
                    label={t("runtimeDiagnostics.lastReachable")}
                    value={displayTime(current.lastReachableAt)}
                  />
                  <DetailRow
                    label={t("runtimeDiagnostics.lastFailure")}
                    value={displayTime(current.lastFailureAt)}
                  />
                  <DetailRow
                    label={t("runtimeDiagnostics.failedEndpoint")}
                    value={current.lastFailedEndpoint ?? "—"}
                  />
                  <DetailRow
                    label={t("runtimeDiagnostics.attempts")}
                    value={String(
                      current.consecutiveFailures || current.lastRecoveryAttempts,
                    )}
                  />
                </section>
                <section>
                  <div className="px-3 pb-1 pt-3 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t("runtimeDiagnostics.runtime")}
                  </div>
                  <DetailRow label={t("runtimeDiagnostics.frontend")} value={`v${__APP_VERSION__}`} />
                  <DetailRow
                    label={t("runtimeDiagnostics.daemon")}
                    value={
                      current.daemonVersion
                        ? `v${current.daemonVersion} · PID ${current.daemonPid ?? "—"}`
                        : "—"
                    }
                  />
                  <DetailRow
                    label={t("runtimeDiagnostics.browserOnline")}
                    value={navigator.onLine ? t("common.yes") : t("common.no")}
                  />
                </section>
                {current.lastError ? (
                  <section className="px-3 py-3">
                    <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                      {t("runtimeDiagnostics.browserError")}
                    </div>
                    <pre className="mt-2 whitespace-pre-wrap break-words border-l-2 border-red-500/50 pl-2 font-mono text-[10px] leading-4 text-foreground">
                      {current.lastError}
                    </pre>
                  </section>
                ) : null}
                <section className="px-3 py-3">
                  <div className="mb-2 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t("runtimeDiagnostics.restartCommands")}
                  </div>
                  {[
                    ["restart", t("runtimeDiagnostics.installed"), restartCommand],
                    ["source", t("runtimeDiagnostics.source"), sourceRestartCommand],
                  ].map(([kind, commandLabel, command]) => (
                    <div className="mb-2 last:mb-0" key={kind}>
                      <span className="text-[10px] text-muted-foreground">{commandLabel}</span>
                      <div className="mt-1 flex items-center gap-1 border border-border bg-background px-2 py-1.5">
                        <code className="min-w-0 flex-1 truncate text-[10px]" title={command}>
                          {command}
                        </code>
                        <button
                          aria-label={t("runtimeDiagnostics.copyCommand", { label: commandLabel })}
                          className="grid size-5 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
                          onClick={() => void copyText(kind as "restart" | "source", command)}
                          type="button"
                        >
                          {copied === kind ? (
                            <Check aria-hidden="true" className="size-3 text-emerald-500" />
                          ) : (
                            <Copy aria-hidden="true" className="size-3" />
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                  <p className="mt-2 border-l-2 border-amber-500/50 pl-2 text-[10px] leading-4 text-muted-foreground">
                    {t("runtimeDiagnostics.restartWarning")}
                  </p>
                </section>
              </div>

              <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/10 p-2">
                <Button
                  className="flex-1"
                  disabled={retrying || mockEnabled}
                  onClick={() => void runProbe(true)}
                  size="sm"
                  type="button"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={cn("size-3.5", retrying && "animate-spin motion-reduce:animate-none")}
                  />
                  {mockEnabled
                    ? t("runtimeDiagnostics.mockPreview")
                    : retrying
                    ? t("runtimeDiagnostics.retrying")
                    : t("runtimeDiagnostics.retry")}
                </Button>
                <Button
                  onClick={() => void copyText("diagnostics", diagnostics)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {copied === "diagnostics" ? (
                    <Check aria-hidden="true" className="size-3.5 text-emerald-500" />
                  ) : (
                    <Copy aria-hidden="true" className="size-3.5" />
                  )}
                  {copied === "diagnostics"
                    ? t("common.copied")
                    : t("runtimeDiagnostics.copyDiagnostics")}
                </Button>
              </div>
                  </aside>
                </ContextMenuTrigger>
                <ContextMenuContent className="z-[1100] w-52">
                  <ContextMenuItem
                    disabled={retrying || mockEnabled}
                    onSelect={() => void runProbe(true)}
                  >
                    <RefreshCw aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />
                    {t("runtimeDiagnostics.retry")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={() => void copyText("diagnostics", diagnostics)}
                  >
                    <Copy aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />
                    {t("runtimeDiagnostics.copyDiagnostics")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
