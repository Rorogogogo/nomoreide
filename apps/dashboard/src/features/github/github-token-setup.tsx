import { useEffect, useRef, useState, type ReactNode } from "react";
import { GitFork, KeyRound, Loader } from "lucide-react";
import {
  pollGitHubDeviceFlow,
  setGitHubToken,
  startGitHubDeviceFlow,
  type GitHubDeviceFlowStart,
  type GitHubTokenInfo,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { useT } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";
import { GitHubAccountSelector } from "./github-account-selector";

type SetupMode = "choose" | "device-pending" | "pat";

export function GitHubTokenSetup({
  deviceFlowAvailable,
  initialMode,
  info,
  onCancel,
  onSaved,
}: {
  deviceFlowAvailable: boolean;
  initialMode?: SetupMode;
  info?: GitHubTokenInfo | null;
  /**
   * Way out for callers that open this over a working connection (the account
   * menu's "add a token"). Without it, `Back` only walks between setup modes
   * and there is no exit from a flow the user opened by choice.
   */
  onCancel?: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<SetupMode>(() => {
    if (initialMode === "device-pending" && !deviceFlowAvailable) return "pat";
    return initialMode ?? (deviceFlowAvailable ? "choose" : "pat");
  });

  if (mode === "device-pending") {
    return <DeviceFlowPending onSuccess={onSaved} onCancel={() => setMode("choose")} />;
  }

  if (mode === "pat") {
    return (
      <PATForm
        onSaved={onSaved}
        // Opened deliberately from a working connection, so Back leaves rather
        // than dropping the user on a "Connect GitHub" screen they don't need.
        onBack={onCancel ?? (deviceFlowAvailable ? () => setMode("choose") : undefined)}
      />
    );
  }

  // "choose" — primary screen
  return (
    <SetupFrame
      description={t("github.setup.connectDesc")}
      icon={<GitFork aria-hidden="true" />}
      title={t("github.setup.connectTitle")}
    >
      <div className="flex flex-col gap-2">
        {info ? <GitHubAccountSelector info={info} onChanged={onSaved} /> : null}
        {info && info.accounts.length > 0 ? (
          <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {t("github.accounts.orConnect")}
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : null}
        <Button className="w-full" onClick={() => setMode("device-pending")} type="button">
          <GitFork aria-hidden="true" className="mr-2 size-4" />
          {t("github.setup.authorizeWith")}
        </Button>
        <button
          className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setMode("pat")}
          type="button"
        >
          {t("github.setup.usePat")}
        </button>
        {onCancel ? (
          <button
            className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={onCancel}
            type="button"
          >
            {t("common.cancel")}
          </button>
        ) : null}
      </div>
    </SetupFrame>
  );
}

function DeviceFlowPending({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [flow, setFlow] = useState<GitHubDeviceFlowStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [copied, setCopied] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef(5);
  const expiredRef = useRef(false);

  // Start the device flow on mount
  useEffect(() => {
    let active = true;
    void startGitHubDeviceFlow()
      .then((data) => {
        if (!active) return;
        setFlow(data);
        intervalRef.current = data.interval;
        setStarting(false);
        const verificationUrl = data.verification_uri_complete || data.verification_uri;
        if (verificationUrl) {
          void openExternal(verificationUrl);
        }
        // Start polling
        scheduleNextPoll(data.device_code, data.interval);
        // Set expiry
        setTimeout(() => { expiredRef.current = true; }, data.expires_in * 1000);
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setStarting(false);
      });
    return () => {
      active = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scheduleNextPoll(deviceCode: string, interval: number) {
    pollTimer.current = setTimeout(() => void doPoll(deviceCode, interval), interval * 1000);
  }

  async function doPoll(deviceCode: string, interval: number) {
    if (expiredRef.current) {
      setError(t("github.setup.expired"));
      return;
    }
    try {
      const result = await pollGitHubDeviceFlow(deviceCode);
      if (result.done) {
        onSuccess();
        return;
      }
      // slow_down: back off by 5 extra seconds
      const nextInterval = result.slowDown ? interval + 5 : interval;
      intervalRef.current = nextInterval;
      scheduleNextPoll(deviceCode, nextInterval);
    } catch {
      // On network error, retry after current interval
      scheduleNextPoll(deviceCode, intervalRef.current);
    }
  }

  function copyCode() {
    if (!flow) return;
    void navigator.clipboard.writeText(flow.user_code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (starting) {
    return (
      <div className="flex h-full items-center justify-center gap-2 bg-background p-4 text-[12px] text-muted-foreground">
        <Loader aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
        {t("github.setup.requesting")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto flex h-full w-full max-w-lg flex-col justify-center gap-3 bg-background p-4">
        <Alert variant="destructive">{error}</Alert>
        <Button className="self-start" onClick={onCancel} size="sm" variant="outline">
          {t("github.setup.goBack")}
        </Button>
      </div>
    );
  }

  return (
    <SetupFrame
      description={
        <>
          {t("github.setup.enterCodePre")}
          <strong className="font-medium text-foreground">
            {t("github.setup.authorizeWord")}
          </strong>
          {t("github.setup.enterCodePost")}
        </>
      }
      icon={<GitFork aria-hidden="true" />}
      title={t("github.setup.authorizeOnTitle")}
    >
      <button
        className="group flex w-full items-center justify-between gap-4 rounded-md border border-border bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={copyCode}
        title={t("github.setup.clickToCopy")}
        type="button"
      >
        <span className="select-all font-mono text-lg font-semibold tracking-[0.2em] text-foreground">
          {flow?.user_code}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground group-hover:text-foreground">
          {copied ? t("common.copied") : t("github.setup.clickCodeCopy")}
        </span>
      </button>

      <div className="mt-3 flex items-center gap-2 border-b border-border/60 pb-3 text-[11px] text-muted-foreground">
        <Loader aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
        {t("github.setup.waiting")}
      </div>
      <div className="mt-3 flex items-center gap-4">
        <a
          className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
          href={flow?.verification_uri_complete || flow?.verification_uri}
          rel="noopener noreferrer"
          target="_blank"
        >
          {t("github.setup.openAgain")}
        </a>
        <button
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={onCancel}
          type="button"
        >
          {t("common.cancel")}
        </button>
      </div>
    </SetupFrame>
  );
}

function PATForm({
  onSaved,
  onBack,
}: {
  onSaved: () => void;
  onBack?: () => void;
}) {
  const t = useT();
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await setGitHubToken("github.com", trimmed);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SetupFrame
      description={
        <>
          {t("github.setup.patDescPre")}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href="https://github.com/settings/tokens/new?scopes=repo,workflow"
            rel="noopener noreferrer"
            target="_blank"
          >
            github.com/settings/tokens
          </a>
          {t("github.setup.patDescMid")}
          <code className="rounded bg-muted px-1 py-px text-[11px]">repo</code>
          {t("github.setup.patDescAnd")}
          <code className="rounded bg-muted px-1 py-px text-[11px]">workflow</code>
          {t("github.setup.patDescPost")}
        </>
      }
      icon={<KeyRound aria-hidden="true" />}
      title={t("github.setup.patTitle")}
    >
      <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
        <input
          autoComplete="off"
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[13px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_..."
          spellCheck={false}
          type="password"
          value={token}
        />
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Button disabled={!token.trim() || saving} type="submit">
          {saving ? t("common.saving") : t("github.setup.saveToken")}
        </Button>
        {onBack ? (
          <button
            className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={onBack}
            type="button"
          >
            {t("github.setup.back")}
          </button>
        ) : null}
      </form>
    </SetupFrame>
  );
}

function SetupFrame({
  children,
  description,
  icon,
  title,
}: {
  children: ReactNode;
  description: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="h-full min-h-0 overflow-auto bg-background">
      <section className="mx-auto w-full max-w-lg px-4 py-8 sm:py-10">
        <div className="flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/20 text-muted-foreground [&_svg]:size-4">
            {icon}
          </div>
          <div className="min-w-0 pt-0.5">
            <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        <div className="mt-5 border-t border-border pt-4">{children}</div>
      </section>
    </div>
  );
}
