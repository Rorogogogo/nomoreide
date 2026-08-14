import type { ProviderProject } from "@/lib/api";
import { Loading } from "@/components/ui/loading";
import { useT } from "@/lib/i18n";
import { SettingsIcon } from "./provider-icons";
import { PanelEmpty } from "./panel-empty";

/**
 * How Vercel builds this project.
 *
 * The point of showing it here is the gap between what the repo says and what
 * Vercel is actually configured to run — the reason a build "used the wrong
 * command" is almost always visible in this list. Nothing here is editable:
 * changing build settings belongs on vercel.com, and this integration's write
 * boundary stops at deployments.
 *
 * Data is owned by the parent tab view, not fetched here — the header's build
 * summary needs the same project record this panel renders.
 */
/** Settings whose values are paths or commands, so they read better monospaced. */
const MONO_SETTINGS = new Set([
  "rootDirectory",
  "buildCommand",
  "installCommand",
  "devCommand",
  "outputDirectory",
]);

export function SettingsPanel({
  project,
  loading,
  error,
}: {
  project: ProviderProject | null;
  loading: boolean;
  error: string | null;
}) {
  const t = useT();

  if (loading && !project) return <Loading fill label={t("common.loading")} />;
  if (error) {
    return (
      <p className="break-words p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {error}
      </p>
    );
  }
  if (!project) {
    return <PanelEmpty icon={<SettingsIcon />}>{t("provider.settings.empty")}</PanelEmpty>;
  }

  // Settings arrive as a provider-declared list rather than known fields, so
  // this renders whatever the provider reports, in the order it reports it.
  // The labels are the provider's own words; only the framework and repository
  // rows below are ours, because they are not build settings.
  const rows: { label: string; value: string | null | undefined; mono?: boolean }[] = [
    { label: t("provider.settings.framework"), value: project.framework },
    ...project.settings.map((setting) => ({
      label: setting.label,
      value: setting.value,
      mono: MONO_SETTINGS.has(setting.key),
    })),
    { label: t("provider.settings.productionBranch"), value: project.link?.productionBranch },
    {
      label: t("provider.settings.repository"),
      value:
        project.link?.org && project.link?.repo
          ? `${project.link.org}/${project.link.repo}`
          : null,
    },
  ];

  return (
    <dl className="divide-y divide-border">
      {rows.map((row) => (
        <SettingRow key={row.label} label={row.label} mono={row.mono} value={row.value} />
      ))}
    </dl>
  );
}

function SettingRow({
  label,
  mono,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string | null | undefined;
}) {
  const t = useT();
  return (
    <div className="flex items-baseline gap-3 px-3 py-1.5">
      <dt className="w-40 shrink-0 text-[11px] text-muted-foreground">{label}</dt>
      {/* Null is a real answer here — Vercel is using the framework's own
          default — so it is spelled out rather than left blank. */}
      <dd
        className={
          value
            ? mono
              ? "min-w-0 flex-1 break-all font-mono text-[11px]"
              : "min-w-0 flex-1 break-words text-[12px]"
            : "min-w-0 flex-1 text-[11px] italic text-muted-foreground"
        }
      >
        {value || t("provider.settings.default")}
      </dd>
    </div>
  );
}
