import { useEffect, useRef, useState } from "react";
import { CheckCircle, GitFork, KeyRound, Loader } from "lucide-react";
import {
  pollGitHubDeviceFlow,
  setGitHubToken,
  startGitHubDeviceFlow,
  type GitHubDeviceFlowStart,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { openExternal } from "@/lib/tauri";

type SetupMode = "choose" | "device-pending" | "pat";

export function GitHubTokenSetup({
  deviceFlowAvailable,
  initialMode,
  onSaved,
}: {
  deviceFlowAvailable: boolean;
  initialMode?: SetupMode;
  onSaved: () => void;
}) {
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
        onBack={deviceFlowAvailable ? () => setMode("choose") : undefined}
      />
    );
  }

  // "choose" — primary screen
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
          <GitFork className="size-6 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Connect GitHub</h2>
          <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
            Authorize NoMoreIDE to read pull requests, issues, and CI status for your repositories.
          </p>
        </div>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-2">
        <Button className="w-full" onClick={() => setMode("device-pending")} type="button">
          <GitFork className="mr-2 size-4" />
          Authorize with GitHub
        </Button>
        <button
          className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setMode("pat")}
          type="button"
        >
          Use a Personal Access Token instead
        </button>
      </div>
    </div>
  );
}

function DeviceFlowPending({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void;
  onCancel: () => void;
}) {
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
      setError("Authorization expired. Please try again.");
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
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader className="size-6 animate-spin text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">Requesting authorization…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <Alert variant="destructive">{error}</Alert>
        <Button onClick={onCancel} variant="outline">Go back</Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-emerald-100 dark:bg-emerald-500/15">
          <CheckCircle className="size-6 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Authorize on GitHub</h2>
          <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
            A GitHub page just opened in a new tab. Enter the code below and click{" "}
            <strong>Authorize</strong>.
          </p>
        </div>
      </div>

      {/* User code display */}
      <div className="flex flex-col items-center gap-2">
        <div
          className="flex cursor-pointer select-all items-center gap-3 rounded-xl border-2 border-border bg-muted px-6 py-4 font-mono text-2xl font-bold tracking-[0.3em] transition-colors hover:border-ring"
          onClick={copyCode}
          title="Click to copy"
        >
          {flow?.user_code}
        </div>
        <button
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={copyCode}
          type="button"
        >
          {copied ? "Copied!" : "Click code to copy"}
        </button>
      </div>

      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader className="size-3.5 animate-spin" />
          Waiting for authorization…
        </div>
        <a
          className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          href={flow?.verification_uri_complete || flow?.verification_uri}
          rel="noopener noreferrer"
          target="_blank"
        >
          Open GitHub again
        </a>
        <button
          className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function PATForm({
  onSaved,
  onBack,
}: {
  onSaved: () => void;
  onBack?: () => void;
}) {
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
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
          <KeyRound className="size-6 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Personal Access Token</h2>
          <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
            Create a token at{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href="https://github.com/settings/tokens/new?scopes=repo,workflow"
              rel="noopener noreferrer"
              target="_blank"
            >
              github.com/settings/tokens
            </a>{" "}
            with <code className="rounded bg-muted px-1 py-px text-[11px]">repo</code> and{" "}
            <code className="rounded bg-muted px-1 py-px text-[11px]">workflow</code> scopes.
          </p>
        </div>
      </div>

      <form className="flex w-full max-w-sm flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
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
          {saving ? "Saving…" : "Save token"}
        </Button>
        {onBack ? (
          <button
            className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={onBack}
            type="button"
          >
            ← Back
          </button>
        ) : null}
      </form>
    </div>
  );
}
