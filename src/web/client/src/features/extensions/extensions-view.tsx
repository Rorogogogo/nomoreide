import { ArrowUpRight, Globe, Puzzle, Server, ShieldCheck, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { InstalledExtension } from "@/lib/api/extensions";
import { useT } from "@/lib/i18n";
import { ProviderLogo } from "../deploy/provider-logo";
import { useInstalledExtensions } from "./use-installed-extensions";

/**
 * Extensions — the section's own page, above the per-plugin pages.
 *
 * Stage 2 of §12 of `docs/plans/2026-08-13-provider-registry-design.md`. It
 * **manages** rather than duplicates: what a card adds beyond the nav entry is
 * the disclosure — what the plugin may do, what it may reach — and, for a
 * plugin whose data also lands somewhere else, where that is. Vultr is the only
 * such case today.
 *
 * Downloaded and Market are stacked sections rather than tabs: with one real
 * section and one empty one, a tab strip would hide the page's only content
 * behind a control. Market is empty on purpose — everything installed ships
 * inside the binary, so a populated store would be invented, next to a panel
 * whose whole value is that it tells the truth about network access.
 */
export function ExtensionsView({ onOpen }: { onOpen?: (id: string) => void }) {
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
    <div className="flex flex-col gap-5 px-4 py-4">
      <section className="flex flex-col gap-3">
        <SectionHeading
          label={t("extensions.section.downloaded", { count: String(extensions.length) })}
        />
        {/*
          Several per row: a card is a short disclosure, not a document, and one
          per line left most of the width empty. It stays readable down to a
          single column on a narrow window.
        */}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {extensions.map((extension) => (
            <ExtensionCard
              extension={extension}
              key={`${extension.kind}:${extension.id}`}
              onOpen={onOpen}
            />
          ))}
        </div>
        <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
          {t("extensions.builtInOnly")}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading label={t("extensions.section.market")} />
        <MarketPanel />
      </section>
    </div>
  );
}

/** A section title with its rule on the same line, as the sidebar's are. */
function SectionHeading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </h2>
      <span aria-hidden className="h-px flex-1 bg-border/60" />
    </div>
  );
}

/**
 * An empty shelf, labelled.
 *
 * Deliberately not a grid of placeholder cards: the blocker is real (§12 —
 * runtime-loading third-party React), and the distribution half genuinely does
 * exist already, so the honest thing is to name both rather than mock a store
 * that cannot install anything.
 */
function MarketPanel() {
  const t = useT();
  return (
    <div className="flex max-w-3xl flex-col items-start gap-2 rounded-lg border border-dashed border-border/60 bg-card/20 p-6">
      <span className="flex items-center gap-2 text-[13px] font-medium">
        <Store aria-hidden className="size-4 text-muted-foreground" />
        {t("extensions.market.title")}
      </span>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("extensions.market.body")}
      </p>
    </div>
  );
}

function ExtensionCard({
  extension,
  onOpen,
}: {
  extension: InstalledExtension;
  onOpen?: (id: string) => void;
}) {
  const t = useT();
  // Only a plugin whose data *also* appears elsewhere has anything to say here;
  // for everything else its page is the whole answer.
  const whereKey = extension.mergesInto === "servers" ? "extensions.where.servers" : null;

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
          {whereKey ? <p className="text-[11px] text-muted-foreground">{t(whereKey)}</p> : null}

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

        {/*
          Open is a corner affordance, not a call to action. Every card on the
          page has one and they all do the same thing, so a labelled button per
          card repeated the plugin's name three times and gave a row of buttons
          more weight than the disclosure they sit next to. The label survives
          on the icon, for anyone who needs it.
        */}
        {onOpen ? (
          <Button
            aria-label={t("extensions.open", { name: extension.name })}
            className="-mr-1 -mt-1 text-muted-foreground hover:text-foreground"
            onClick={() => onOpen(extension.id)}
            size="icon-sm"
            title={t("extensions.open", { name: extension.name })}
            type="button"
            variant="ghost"
          >
            <ArrowUpRight aria-hidden />
          </Button>
        ) : null}
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
