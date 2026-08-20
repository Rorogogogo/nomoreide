import { Globe, Server, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { InstalledExtension } from "@/lib/api/extensions";
import { useT } from "@/lib/i18n";
import { DeployView } from "../deploy/deploy-view";
import { ProviderLogo } from "../deploy/provider-logo";

/**
 * One installed plugin's own page — the second layer of the nav.
 *
 * §12, owner's call: Vercel and Cloudflare are two entries with two pages,
 * not one Deploy view with a switcher inside it. This component is the whole
 * of that decision: it maps a plugin to the view for its *kind*, and the kind
 * is the only thing it branches on. A fourth deploy provider needs no edit
 * here, which is the same property the registry and route modules have.
 *
 * What it does **not** do is relocate a plugin's data. A host plugin's page is
 * a management page, deliberately not a second server list — building one
 * would undo §7's payoff exactly as §12 warned.
 */
export function ExtensionPage({
  extension,
  onOpenServers,
}: {
  extension: InstalledExtension;
  onOpenServers?: () => void;
}) {
  if (extension.kind === "deploy") {
    // `key` so switching Vercel → Cloudflare drops every piece of state below
    // it rather than showing one provider's data under the other's name until
    // each fetch resolves. Previously the in-view switcher's job.
    return <DeployView key={extension.id} providerId={extension.id} />;
  }
  return <HostExtensionPage extension={extension} onOpenServers={onOpenServers} />;
}

/**
 * A host plugin's page: what it is, what it may do, what it may reach, and
 * where its machines actually appear.
 *
 * That last line is the one that earns the page. A user who installs Vultr and
 * finds a page with no servers on it has learned the wrong thing; the page has
 * to say that the instances are in the SSH list, beside machines no plugin
 * owns.
 */
function HostExtensionPage({
  extension,
  onOpenServers,
}: {
  extension: InstalledExtension;
  onOpenServers?: () => void;
}) {
  const t = useT();

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Server aria-hidden className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-medium">{extension.name}</span>
        <Badge variant="secondary">{t("extensions.kind.host")}</Badge>
        <Badge variant="outline">{t("extensions.source.builtIn")}</Badge>
      </div>

      <p className="max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
        {t("extensions.page.hostWhere", { name: extension.name })}
      </p>

      {onOpenServers ? (
        <div>
          <Button onClick={onOpenServers} size="sm" type="button" variant="outline">
            {t("extensions.page.openServers")}
          </Button>
        </div>
      ) : null}

      <DetailRow
        icon={<ShieldCheck aria-hidden className="size-3" />}
        label={t("extensions.actions")}
        values={extension.actions.map((action) =>
          extension.productionAffecting.includes(action) ? `${action} *` : action,
        )}
      />
      <DetailRow
        icon={<Globe aria-hidden className="size-3" />}
        label={t("extensions.hosts")}
        values={extension.hosts}
      />
    </div>
  );
}

/** A plugin id the registry does not know — a stale bookmark, or one removed. */
export function UnknownExtensionPage({ id }: { id: string }) {
  const t = useT();
  return (
    <p className="px-4 py-10 text-[12px] text-muted-foreground">
      {t("extensions.page.unknown", { id })}
    </p>
  );
}

function DetailRow({
  icon,
  label,
  values,
}: {
  icon: React.ReactNode;
  label: string;
  values: string[];
}) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {icon}
        {label}
      </span>
      {values.map((value) => (
        <code
          className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
          key={value}
        >
          {value}
        </code>
      ))}
    </div>
  );
}

/** The logo a nav row or page header shows for a plugin. */
export function ExtensionIcon({ extension }: { extension: InstalledExtension }) {
  return extension.kind === "deploy" ? (
    <ProviderLogo providerId={extension.id} />
  ) : (
    <Server aria-hidden />
  );
}
