import { useEffect, useState } from "react";
import { Download, ExternalLink, RefreshCw, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getAgentEnvProfileRegistryDiff,
  type AgentEnvProfileRegistryDiff,
  type AgentEnvProfileRegistryItemDiff,
  type AgentEnvProfileRegistryLinkSummary,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";

export function ProfilePublicationDetails({
  busy,
  link,
  name,
  onInstall,
  onPublish,
  registryFrontendUrl,
  registryVersion,
}: {
  busy: boolean;
  link: AgentEnvProfileRegistryLinkSummary;
  name: string;
  onInstall: (slug: string) => Promise<boolean>;
  onPublish: (name: string) => void;
  registryFrontendUrl?: string;
  registryVersion?: string;
}) {
  const t = useT();
  const [result, setResult] = useState<AgentEnvProfileRegistryDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const registryChanged = Boolean(registryVersion && registryVersion !== link.version);

  useEffect(() => {
    let active = true;
    setError(null);
    void getAgentEnvProfileRegistryDiff(name)
      .then((next) => {
        if (active) setResult(next);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [name]);

  return (
    <div className="border-t border-border/60 bg-muted/10 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium">
            {t("agentEnv.publicationComparison")}
            <code className="ml-2 text-[10px] font-normal text-muted-foreground">
              {link.slug} · v{link.version}
              {registryChanged ? ` → v${registryVersion}` : ""}
            </code>
          </p>
          {error ? (
            <p className="mt-1 text-[11px] text-destructive">{error}</p>
          ) : !result ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("agentEnv.publicationComparing")}
            </p>
          ) : (
            <PublicationChanges result={result} registryChanged={registryChanged} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {link.origin === "published" ? (
            <Button disabled={busy} onClick={() => onPublish(name)} size="sm" variant="outline">
              <UploadCloud aria-hidden="true" />
              {t("agentEnv.publishUpdate")}
            </Button>
          ) : null}
          {registryChanged ? (
            <Button
              disabled={busy}
              onClick={() => void onInstall(link.slug)}
              size="sm"
              variant="outline"
            >
              <Download aria-hidden="true" />
              {t("agentEnv.installRegistryVersion")}
            </Button>
          ) : null}
          {registryFrontendUrl ? (
            <Button
              onClick={() =>
                void openExternal(
                  `${registryFrontendUrl.replace(/\/$/, "")}/profiles/${encodeURIComponent(link.slug)}`,
                )
              }
              size="sm"
              variant="ghost"
            >
              <ExternalLink aria-hidden="true" />
              {t("agentEnv.openRegistryProfile")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PublicationChanges({
  registryChanged,
  result,
}: {
  registryChanged: boolean;
  result: AgentEnvProfileRegistryDiff;
}) {
  const t = useT();
  const groups = [
    [t("agentEnv.mcpServers"), result.diff.mcps],
    [t("agentEnv.skills"), result.diff.skills],
    [t("agentEnv.plugins"), result.diff.plugins],
  ] as const;
  const visible = groups.filter(([, diff]) => hasItemChanges(diff));

  if (!result.diff.hasLocalChanges && !registryChanged) {
    return <p className="mt-1 text-[11px] text-emerald-600">{t("agentEnv.publicationUpToDate")}</p>;
  }

  return (
    <div className="mt-2 space-y-1.5 text-[11px]">
      {registryChanged ? (
        <p className="text-sky-600">{t("agentEnv.publicationRegistryChanged")}</p>
      ) : null}
      {result.diff.descriptionChanged ? (
        <p className="text-amber-600">{t("agentEnv.publicationDescriptionChanged")}</p>
      ) : null}
      {result.diff.sourceAgentChanged ? (
        <p className="text-amber-600">{t("agentEnv.publicationSourceChanged")}</p>
      ) : null}
      {visible.map(([label, diff]) => (
        <div className="flex flex-wrap gap-x-2" key={label}>
          <span className="font-medium text-foreground">{label}</span>
          <DiffNames label={t("agentEnv.publicationAdded")} names={diff.added} tone="text-emerald-600" />
          <DiffNames label={t("agentEnv.publicationRemoved")} names={diff.removed} tone="text-rose-600" />
          <DiffNames label={t("agentEnv.publicationChanged")} names={diff.changed} tone="text-amber-600" />
        </div>
      ))}
      {result.diff.hasLocalChanges && visible.length === 0 && !result.diff.descriptionChanged && !result.diff.sourceAgentChanged ? (
        <p className="flex items-center gap-1 text-amber-600">
          <RefreshCw aria-hidden="true" className="size-3" />
          {t("agentEnv.publicationBundleChanged")}
        </p>
      ) : null}
    </div>
  );
}

function DiffNames({
  label,
  names,
  tone,
}: {
  label: string;
  names: string[];
  tone: string;
}) {
  if (names.length === 0) return null;
  return (
    <span className={tone}>
      {label}: <span className="font-mono">{names.join(", ")}</span>
    </span>
  );
}

function hasItemChanges(diff: AgentEnvProfileRegistryItemDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}
