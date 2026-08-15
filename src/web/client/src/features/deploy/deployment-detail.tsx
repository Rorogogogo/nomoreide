import { useEffect, useState, type ReactNode } from "react";
import {
  type ProviderDeployment,
  type ProviderDeploymentDetail,
  type ProviderLogLine,
} from "@/lib/api";
import { useProviderApi, useProviderManifest, useProviderString } from "./provider-client";
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
} from "./provider-icons";
import { DeploymentStateBadge } from "./deployment-state-badge";

const IN_FLIGHT = new Set(["building", "queued"]);
const LOG_POLL_MS = 5_000;

/** Just enough of a deployment to decide whether an action applies to it. */
type ActionSubject = Pick<
  ProviderDeploymentDetail,
  "state" | "target" | "isCurrentProduction"
>;

/**
 * Where the host puts an action, and when it applies — keyed by action name.
 *
 * **This table is the host's half; the provider's half is its manifest.** The
 * provider decides *which* actions exist (`manifest.actions`), what each is
 * called and what its confirmation says (`manifest.strings`); the host decides
 * what a button looks like and which deployment states it makes sense for. That
 * split is why Cloudflare — two actions, no `promote` — renders correctly
 * through the same component that renders Vercel's four.
 *
 * Keying placement by name is the residue this change deliberately leaves
 * behind. It means a provider inventing a genuinely new verb gets a button in
 * the default position rather than a well-placed one, which is a far smaller
 * failure than the previous behaviour (no button at all, and a label that
 * rendered as `provider.action.publish`). Making placement itself declarative
 * needs a vocabulary for "when does this apply", and inventing one before a
 * provider needs it is the over-abstraction §9 warns against — it belongs with
 * the rest of §12 stage 3, where the manifest becomes data.
 */
const PLACEMENT: Record<
  string,
  { icon: ReactNode; variant: "default" | "outline"; applies: (d: ActionSubject) => boolean }
> = {
  cancel: {
    icon: <CancelIcon />,
    variant: "outline",
    applies: (d) => IN_FLIGHT.has(d.state),
  },
  // Complementary to `cancel`: a build either can be stopped or can be run
  // again, never both. Two predicates rather than the if/else this replaced.
  redeploy: {
    icon: <RefreshIcon />,
    variant: "outline",
    applies: (d) => !IN_FLIGHT.has(d.state),
  },
  promote: {
    icon: <PromoteIcon />,
    variant: "default",
    applies: (d) => d.state === "ready" && !d.isCurrentProduction,
  },
  rollback: {
    icon: <RollbackIcon />,
    variant: "outline",
    applies: (d) =>
      d.state === "ready" && d.target === "production" && !d.isCurrentProduction,
  },
};

/** An action name the host has no placement for — see the note on {@link PLACEMENT}. */
const DEFAULT_PLACEMENT = {
  icon: <RefreshIcon />,
  variant: "outline" as const,
  applies: (d: ActionSubject) => !IN_FLIGHT.has(d.state),
};

/**
 * One deployment: its state, where it came from, and its build log — plus
 * whichever actions the provider declares can change it.
 *
 * Which actions those are comes from `manifest.actions`, and which of them
 * confirm first from `manifest.productionAffecting`. Nothing here names Vercel's
 * four, which is what stops Cloudflare — with `["redeploy", "rollback"]` — from
 * rendering a Promote button the server then rejects.
 */
export function DeploymentDetail({
  deployment: summary,
  onChanged,
}: {
  deployment: ProviderDeployment;
  onChanged: () => void;
}) {
  const t = useT();
  const api = useProviderApi();
  const manifest = useProviderManifest();
  const ps = useProviderString();
  const toasts = useToasts();
  const [detail, setDetail] = useState<ProviderDeploymentDetail | null>(null);
  const [logs, setLogs] = useState<ProviderLogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const uid = summary.id;
  const live = IN_FLIGHT.has(detail?.state ?? summary.state);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    async function load(showSpinner: boolean) {
      if (showSpinner) setLoading(true);
      try {
        const [nextDetail, nextLogs] = await Promise.all([
          api.getDeployment(uid),
          api.getDeploymentLogs(uid).catch(() => [] as ProviderLogLine[]),
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
      void Promise.all([api.getDeployment(uid), api.getDeploymentLogs(uid)])
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

  async function run(action: string) {
    setPending(action);
    try {
      await api.runDeploymentAction(uid, action);
      // Falls back to the action's own name: a provider that declared an action
      // but no `.done` string still gets a truthful toast rather than a raw key.
      toasts.success(ps(`action.${action}.done`) ?? action);
      onChanged();
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
      setConfirming(null);
    }
  }

  const current = detail ?? { ...summary, aliases: [] as string[] };
  const isProduction = current.target === "production";

  // A null manifest yields no buttons — deliberately the opposite of
  // `useCapability`, which assumes support while loading. The asymmetry follows
  // the cost: wrongly hiding a *tab* costs a visible feature for one paint,
  // while wrongly showing an *action* costs a write the server rejects. This
  // view is only reachable once the provider has answered, so the state is
  // near-unobservable either way.
  const available = (manifest?.actions ?? []).filter((action) =>
    (PLACEMENT[action] ?? DEFAULT_PLACEMENT).applies(current),
  );
  const confirms = (action: string) => manifest?.productionAffecting.includes(action) ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 space-y-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <DeploymentStateBadge rawState={current.rawState} state={current.state} />
          <span className="text-[11px] text-muted-foreground">
            {formatRelativeTime(new Date(current.createdAt).toISOString())}
          </span>
          {isProduction ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
              {t("provider.target.production")}
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
                {t("provider.visit")}
              </Button>
            ) : null}
            {available.map((action) => {
              const placement = PLACEMENT[action] ?? DEFAULT_PLACEMENT;
              return (
                <Button
                  key={action}
                  loading={pending === action}
                  onClick={() =>
                    confirms(action) ? setConfirming(action) : void run(action)
                  }
                  size="sm"
                  type="button"
                  variant={placement.variant}
                >
                  {placement.icon}
                  {ps(`action.${action}`) ?? action}
                </Button>
              );
            })}
          </span>
        </div>

        <p className="truncate text-[13px] font-medium">
          {current.meta.commitMessage || current.url || current.id}
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
          confirmLabel={ps(`action.${confirming}`) ?? confirming}
          icon={(PLACEMENT[confirming] ?? DEFAULT_PLACEMENT).icon}
          loading={pending === confirming}
          // Falls back to the generic warning: a provider that declared an
          // action production-affecting but wrote no confirmation still gets a
          // dialog, because losing the *confirmation step* is the one failure
          // mode here that costs more than a bad string.
          message={ps(`action.${confirming}.confirm`) ?? t("provider.confirm.generic")}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void run(confirming)}
          title={ps(`action.${confirming}.confirmTitle`) ?? t("provider.confirm.genericTitle")}
          // `default` is the host's "this is the forward move" variant, which
          // among Vercel's actions is exactly `promote`. Anything else — an
          // unplaced action included — confirms in the cautious tone.
          tone={
            (PLACEMENT[confirming] ?? DEFAULT_PLACEMENT).variant === "default"
              ? "success"
              : "danger"
          }
        />
      ) : null}
    </div>
  );
}
