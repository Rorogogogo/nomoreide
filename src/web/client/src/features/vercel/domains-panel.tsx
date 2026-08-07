import type { VercelDomain } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { useToasts } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";
import { useVercelDomains } from "./hooks/use-vercel-resource";
import {
  CopyIcon,
  ExternalIcon,
  UnverifiedIcon,
  VerifiedIcon,
} from "./vercel-icons";

/**
 * The project's domains: which ones serve it, which redirect, and which are
 * still waiting on DNS.
 *
 * An unverified domain is the only state here that needs the user to *do*
 * something, so it is the only one that expands — the DNS records Vercel wants
 * are shown inline and are copyable, which is the whole task.
 */
export function DomainsPanel() {
  const t = useT();
  const { data: domains, loading, error, refresh } = useVercelDomains();
  useRegisterRefresh(refresh);

  if (loading && domains.length === 0) return <Loading fill label={t("common.loading")} />;
  if (error) {
    return (
      <p className="break-words p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {error}
      </p>
    );
  }
  if (domains.length === 0) {
    return <p className="p-4 text-[12px] text-muted-foreground">{t("vercel.domains.empty")}</p>;
  }

  // Unverified first: they are the ones with an outstanding action.
  const ordered = [...domains].sort(
    (a, b) => Number(a.verified) - Number(b.verified) || a.name.localeCompare(b.name),
  );

  return (
    <div className="divide-y divide-border">
      {ordered.map((domain) => (
        <DomainRow domain={domain} key={domain.name} />
      ))}
    </div>
  );
}

function DomainRow({ domain }: { domain: VercelDomain }) {
  const t = useT();
  const toasts = useToasts();

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    toasts.success(t("vercel.domains.copied"));
  }

  return (
    <div className="space-y-1.5 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {domain.verified ? (
          <VerifiedIcon className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <UnverifiedIcon className="size-3.5 shrink-0 text-amber-500" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium">
          {domain.name}
        </span>

        {domain.redirect ? (
          <span className="shrink-0 truncate rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
            {t("vercel.domains.redirectsTo", { target: domain.redirect })}
          </span>
        ) : null}
        {domain.gitBranch ? (
          <span className="shrink-0 rounded border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground">
            {domain.gitBranch}
          </span>
        ) : null}

        <Button
          onClick={() => openExternal(`https://${domain.name}`)}
          size="icon-sm"
          title={t("vercel.visit")}
          type="button"
          variant="ghost"
        >
          <ExternalIcon />
        </Button>
      </div>

      {!domain.verified && domain.verification.length > 0 ? (
        <div className="space-y-1 rounded border border-amber-500/30 bg-amber-500/5 p-2">
          <p className="text-[11px] text-muted-foreground">{t("vercel.domains.addRecords")}</p>
          {domain.verification.map((record) => (
            <div
              className="flex items-center gap-2 font-mono text-[10px]"
              key={`${record.type}-${record.domain}-${record.value}`}
            >
              <span className="shrink-0 rounded bg-muted px-1 py-px">{record.type}</span>
              <span className="shrink-0 text-muted-foreground">{record.domain}</span>
              <span className="min-w-0 flex-1 truncate">{record.value}</span>
              <Button
                onClick={() => void copy(record.value)}
                size="icon-sm"
                title={t("vercel.domains.copyRecord")}
                type="button"
                variant="ghost"
              >
                <CopyIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
