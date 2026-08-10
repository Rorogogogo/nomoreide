import { CheckCircle2, KeyRound, TerminalSquare, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/cvui-badge";
import {
  getSshSetupStatus,
  openSshSetupTerminal,
  probeSshServer,
  type SshSetupStatus,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

type TestResult =
  | { destination: string; ok: true }
  | { destination: string; ok: false; error: string };

const SETUP_BUTTON_CLASS = "h-7 px-2 text-[11px] [&_svg]:size-3.5";

export function SshSetupPanel({
  destination,
  onOpenTerminal,
}: {
  destination: string;
  onOpenTerminal: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<SshSetupStatus | null>(null);
  const [testingDestination, setTestingDestination] = useState<string | null>(null);
  const [opening, setOpening] = useState<"generate-key" | "install-key" | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const destinationRef = useRef(destination);
  destinationRef.current = destination;

  useEffect(() => {
    let cancelled = false;
    void getSshSetupStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const testAccess = async () => {
    if (!destination) return;
    const requestedDestination = destination;
    setTestingDestination(requestedDestination);
    setError(null);
    setResult(null);
    try {
      const probe = await probeSshServer(destination);
      if (requestedDestination !== destinationRef.current) return;
      setResult(probe.reachable
        ? { destination: requestedDestination, ok: true }
        : {
            destination: requestedDestination,
            ok: false,
            error: probe.error ?? "Connection failed",
          });
    } catch (nextError) {
      if (requestedDestination !== destinationRef.current) return;
      setResult({
        destination: requestedDestination,
        ok: false,
        error: nextError instanceof Error ? nextError.message : String(nextError),
      });
    } finally {
      if (requestedDestination === destinationRef.current) setTestingDestination(null);
    }
  };

  const openSetupTerminal = async (action: "generate-key" | "install-key") => {
    setOpening(action);
    setError(null);
    try {
      await openSshSetupTerminal(action, action === "install-key" ? destination : undefined);
      onOpenTerminal();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setOpening(null);
    }
  };

  const keyCount = status?.publicKeys.length ?? 0;
  const testing = testingDestination === destination;
  const visibleResult = result?.destination === destination ? result : null;

  return (
    <section
      aria-labelledby="ssh-setup-heading"
      className="border-t border-border pt-2 sm:col-span-2 lg:col-span-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            id="ssh-setup-heading"
          >
            <KeyRound aria-hidden="true" className="size-3.5 text-muted-foreground" />
            {t("servers.setup.title")}
          </h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {t("servers.setup.body")}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {status ? (
            <>
              <Badge
                appearance="subtle"
                size="small"
                variant={keyCount > 0 ? "success" : "warning"}
              >
                {keyCount > 0
                  ? t("servers.setup.keysFound", { count: String(keyCount) })
                  : t("servers.setup.noKeys")}
              </Badge>
              <Badge
                appearance="subtle"
                size="small"
                variant={status.sshCopyIdAvailable ? "success" : "warning"}
              >
                {status.sshCopyIdAvailable
                  ? t("servers.setup.copyIdReady")
                  : t("servers.setup.copyIdMissing")}
              </Badge>
            </>
          ) : (
            <Badge isLoading={!error} size="small" variant="secondary">
              {error ? t("servers.setup.unavailable") : t("servers.setup.checking")}
            </Badge>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-y border-border/70 py-1.5">
        <Button
          className={SETUP_BUTTON_CLASS}
          disabled={!destination || opening !== null}
          loading={testing}
          loadingLabel={t("servers.setup.testing")}
          onClick={() => void testAccess()}
          size="sm"
          type="button"
          variant="outline"
        >
          <CheckCircle2 aria-hidden="true" />
          {t("servers.setup.test")}
        </Button>
        <Button
          className={SETUP_BUTTON_CLASS}
          disabled={opening !== null || testing}
          loading={opening === "generate-key"}
          onClick={() => void openSetupTerminal("generate-key")}
          size="sm"
          type="button"
          variant="outline"
        >
          <KeyRound aria-hidden="true" />
          {t("servers.setup.generate")}
        </Button>
        <Button
          className={SETUP_BUTTON_CLASS}
          disabled={
            !destination || keyCount === 0 || !status?.sshCopyIdAvailable ||
            opening !== null || testing
          }
          loading={opening === "install-key"}
          onClick={() => void openSetupTerminal("install-key")}
          size="sm"
          type="button"
          variant="outline"
        >
          <TerminalSquare aria-hidden="true" />
          {t("servers.setup.install")}
        </Button>
      </div>

      {visibleResult ? (
        <p
          aria-live="polite"
          className={visibleResult.ok
            ? "mt-2 flex items-start gap-1.5 text-[10px] text-emerald-700 dark:text-emerald-300"
            : "mt-2 flex items-start gap-1.5 text-[10px] text-red-700 dark:text-red-300"}
          role="status"
        >
          {visibleResult.ok
            ? <CheckCircle2 aria-hidden="true" className="mt-px size-3 shrink-0" />
            : <TriangleAlert aria-hidden="true" className="mt-px size-3 shrink-0" />}
          {visibleResult.ok
            ? t("servers.setup.testSuccess")
            : t("servers.setup.testFailed", { error: visibleResult.error })}
        </p>
      ) : null}
      {status && !status.sshCopyIdAvailable ? (
        <p className="mt-1.5 text-[9px] leading-4 text-muted-foreground">
          {t("servers.setup.copyIdHelp")}
        </p>
      ) : null}
      <p className="mt-1.5 text-[9px] leading-4 text-muted-foreground">
        {t("servers.setup.installHint")}
      </p>
      {error ? (
        <p aria-live="polite" className="mt-1.5 text-[10px] text-destructive">
          {t("servers.setup.error", { error })}
        </p>
      ) : null}
    </section>
  );
}
