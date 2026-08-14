import { Globe, Puzzle, Server, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { InstalledExtension } from "@/lib/api/extensions";
import { useT } from "@/lib/i18n";
import { ProviderLogo } from "../deploy/provider-logo";
import { useInstalledExtensions } from "./use-installed-extensions";

/**
 * Extensions — what is installed, what it may do, and what it may reach.
 *
 * Stage 2 of §12 of `docs/plans/2026-08-13-provider-registry-design.md`. This
 * section **manages** plugins; it does not host their features. A deploy
 * plugin's projects and deployments live under Deploy, a host plugin's machines
 * live in Servers, and each row says so — because the nav groups by what a
 * thing *is*, not by how it was installed, and a manager that hid where its
 * features went would undo that.
 *
 * No install, no remove, no browse: everything installed is built-in, so those
 * controls would be decoration. The footer states that outright rather than
 * showing three disabled buttons.
 */
export function ExtensionsView() {
  const t = useT();
  const { extensions, loading, error } = useInstalledExtensions();

  if (error) {
    return (
      <p className="px-4 py-10 text-[12px] text-destructive">
        {t("extensions.error", { error })}
      </p>
    );
  }

  if (loading && extensions.length === 0) {
    return (
      <p className="px-4 py-10 text-[12px] text-muted-foreground">{t("common.loading")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex flex-col gap-3">
        {extensions.map((extension) => (
          <ExtensionCard extension={extension} key={`${extension.kind}:${extension.id}`} />
        ))}
      </div>
      <p className="max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
        {t("extensions.builtInOnly")}
      </p>
    </div>
  );
}

function ExtensionCard({ extension }: { extension: InstalledExtension }) {
  const t = useT();
  const whereKey = extension.page === "servers" ? "extensions.where.servers" : null;

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-muted-foreground">
          {extension.kind === "deploy" ? (
            <ProviderLogo className="size-4" providerId={extension.id} />
          ) : (
            <Server aria-hidden className="size-4" />
          )}
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">{extension.name}</span>
            <Badge variant="secondary">
              {t(extension.kind === "deploy" ? "extensions.kind.deploy" : "extensions.kind.host")}
            </Badge>
            <Badge variant="outline">{t("extensions.source.builtIn")}</Badge>
          </div>

          {/*
            Where the plugin's features actually are. Vultr is the case that
            makes this worth a line: it has no tab, because its instances merge
            into the SSH server list, and without this sentence "I installed
            Vultr and nothing appeared" is the obvious wrong conclusion.
          */}
          {whereKey ? (
            <p className="text-[11px] text-muted-foreground">{t(whereKey)}</p>
          ) : (
            <p className="text-[11px] text-muted-foreground">{t("extensions.where.deploy")}</p>
          )}

          {extension.capabilities.length > 0 ? (
            <DetailRow
              icon={<Puzzle aria-hidden className="size-3" />}
              label={t("extensions.capabilities")}
              values={extension.capabilities}
            />
          ) : null}

          {extension.actions.length > 0 ? (
            <DetailRow
              icon={<ShieldCheck aria-hidden className="size-3" />}
              label={t("extensions.actions")}
              /*
                Guarded actions are marked rather than listed separately: the
                question a reader has is "which of these change something I care
                about", and splitting the list into two makes that harder to see,
                not easier.
              */
              values={extension.actions.map((action) =>
                extension.productionAffecting.includes(action) ? `${action} *` : action,
              )}
            />
          ) : null}

          {/*
            The reason this page exists now rather than after the marketplace
            opens. `api.hosts` is enforced invisibly by `createProviderFetch`;
            printing it turns enforcement into disclosure, and the surface gets
            to be trustworthy while every answer is still verifiable in-tree.
          */}
          <DetailRow
            icon={<Globe aria-hidden className="size-3" />}
            label={t("extensions.hosts")}
            values={extension.hosts}
          />
        </div>
      </div>
    </div>
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
