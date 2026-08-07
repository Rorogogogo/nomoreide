import { useEffect, useState } from "react";
import {
  getVercelDeployment,
  getVercelDeploymentLogs,
  runVercelDeploymentAction,
  type VercelBuildLogLine,
  type VercelDeployment,
  type VercelDeploymentAction,
  type VercelDeploymentDetail,
} from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToasts } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";
import { formatRelativeTime } from "@/lib/utils";
import { DeploymentLogs } from "./deployment-logs";
import {
  CancelIcon,
  ExternalIcon,
  PromoteIcon,
  RefreshIcon,
  RollbackIcon,
} from "./vercel-icons";
import { DeploymentStateBadge } from "./deployment-state-badge";

const IN_FLIGHT = new Set(["BUILDING", "INITIALIZING", "QUEUED"]);
const LOG_POLL_MS = 5_000;

/**
 * One deployment: its state, where it came from, and its build log — plus the
 * four actions that can change it.
 *
 * `promote` and `rollback` re-point production, so both confirm first; they
 * are the only irreversible-in-effect things this tab can do. `redeploy` and
 * `cancel` don't, and fire straight away.
 */
export function DeploymentDetail({
  deployment: summary,
  onChanged,
}: {
  deployment: VercelDeployment;
  onChanged: () => void;
}) {
  const t = useT();
  const toasts = useToasts();
  const [detail, setDetail] = useState<VercelDeploymentDetail | null>(null);
  const [logs, setLogs] = useState<VercelBuildLogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<VercelDeploymentAction | null>(null);
  const [confirming, setConfirming] = useState<"promote" | "rollback" | null>(null);

  const uid = summary.uid;
  const live = IN_FLIGHT.has(detail?.state ?? summary.state);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    async function load(showSpinner: boolean) {
      if (showSpinner) setLoading(true);
      try {
        const [nextDetail, nextLogs] = await Promise.all([
          getVercelDeployment(uid),
          getVercelDeploymentLogs(uid).catch(() => [] as VercelBuildLogLine[]),
        ]);
        if (!active) return;
        setDetail(nextDetail);
        setLogs(nextLogs);
        setError(null);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (active) setLoading(false);
      }
    }

    void load(true);
    return () => {
      active = false;
    };
  }, [uid]);

  // A running build's logs arrive as it goes; a finished one is already final,
  // so polling stops rather than re-fetching an unchanging document forever.
  useEffect(() => {
    if (!live) return;
    let active = true;
    const timer = setInterval(() => {
      void Promise.all([getVercelDeployment(uid), getVercelDeploymentLogs(uid)])
        .then(([nextDetail, nextLogs]) => {
          if (!active) return;
          setDetail(nextDetail);
          setLogs(nextLogs);
        })
        .catch(() => {
          /* keep the last good render; the next tick may recover */
        });
    }, LOG_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [live, uid]);

  async function run(action: VercelDeploymentAction) {
    setPending(action);
    try {
      const res = await runVercelDeploymentAction(uid, action);
      toasts.success(
        action === "redeploy" && res.deployment?.uid
          ? t("vercel.action.redeployStarted")
          : t(`vercel.action.${action}Done`),
      );
      onChanged();
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
      setConfirming(null);
    }
  }

  const current = detail ?? { ...summary, aliases: [] as string[] };
  const canCancel = IN_FLIGHT.has(current.state);
  const isProduction = current.target === "production";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 space-y-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <DeploymentStateBadge state={current.state} />
          <span className="text-[11px] text-muted-foreground">
            {formatRelativeTime(new Date(current.createdAt).toISOString())}
          </span>
          {isProduction ? (
            <span className="rounded border border-emerald-500/40 px-1.5 py-px text-[10px] text-emerald-500">
              {t("vercel.target.production")}
            </span>
          ) : null}
          <span className="ml-auto flex flex-wrap gap-1.5">
            {current.url ? (
              <Button
                onClick={() => openExternal(`https://${current.url}`)}
                size="sm"
                type="button"
                variant="outline"
              >
                <ExternalIcon />
                {t("vercel.visit")}
              </Button>
            ) : null}
            {canCancel ? (
              <Button
                loading={pending === "cancel"}
                onClick={() => void run("cancel")}
                size="sm"
                type="button"
                variant="outline"
              >
                <CancelIcon />
                {t("vercel.action.cancel")}
              </Button>
            ) : (
              <Button
                loading={pending === "redeploy"}
                onClick={() => void run("redeploy")}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshIcon />
                {t("vercel.action.redeploy")}
              </Button>
            )}
            {current.state === "READY" && !current.isCurrentProduction ? (
              <Button
                loading={pending === "promote"}
                onClick={() => setConfirming("promote")}
                size="sm"
                type="button"
                variant="default"
              >
                <PromoteIcon />
                {t("vercel.action.promote")}
              </Button>
            ) : null}
            {current.state === "READY" && isProduction && !current.isCurrentProduction ? (
              <Button
                loading={pending === "rollback"}
                onClick={() => setConfirming("rollback")}
                size="sm"
                type="button"
                variant="outline"
              >
                <RollbackIcon />
                {t("vercel.action.rollback")}
              </Button>
            ) : null}
          </span>
        </div>

        <p className="truncate text-[13px] font-medium">
          {current.meta.commitMessage || current.url || current.uid}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {[
            current.meta.branch,
            current.meta.sha?.slice(0, 7),
            current.creator?.username,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {current.errorMessage ? (
          <Alert variant="destructive">{current.errorMessage}</Alert>
        ) : null}
        {error ? <Alert variant="destructive">{error}</Alert> : null}
      </header>

      <DeploymentLogs buildLogs={logs} loading={loading} uid={uid} />

      {confirming ? (
        <ConfirmDialog
          confirmLabel={t(`vercel.action.${confirming}`)}
          icon={confirming === "promote" ? <PromoteIcon /> : <RollbackIcon />}
          loading={pending === confirming}
          message={t(
            confirming === "promote" ? "vercel.confirm.promote" : "vercel.confirm.rollback",
          )}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void run(confirming)}
          title={t(
            confirming === "promote"
              ? "vercel.confirm.promoteTitle"
              : "vercel.confirm.rollbackTitle",
          )}
          tone={confirming === "promote" ? "success" : "danger"}
        />
      ) : null}
    </div>
  );
}
