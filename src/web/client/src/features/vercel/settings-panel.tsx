import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { useT } from "@/lib/i18n";
import { useVercelProjectSettings } from "./hooks/use-vercel-resource";
import { SettingsIcon } from "./vercel-icons";
import { PanelEmpty } from "./panel-empty";

/**
 * How Vercel builds this project.
 *
 * The point of showing it here is the gap between what the repo says and what
 * Vercel is actually configured to run — the reason a build "used the wrong
 * command" is almost always visible in this list. Nothing here is editable:
 * changing build settings belongs on vercel.com, and this integration's write
 * boundary stops at deployments.
 */
export function SettingsPanel() {
  const t = useT();
  const { data: project, loading, error, refresh } = useVercelProjectSettings();
  useRegisterRefresh(refresh);

  if (loading && !project) return <Loading fill label={t("common.loading")} />;
  if (error) {
    return (
      <p className="break-words p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {error}
      </p>
    );
  }
  if (!project) {
    return <PanelEmpty icon={<SettingsIcon />}>{t("vercel.settings.empty")}</PanelEmpty>;
  }

  const rows: { label: string; value: string | null | undefined; mono?: boolean }[] = [
    { label: t("vercel.settings.framework"), value: project.framework },
    { label: t("vercel.settings.nodeVersion"), value: project.nodeVersion },
    { label: t("vercel.settings.rootDirectory"), value: project.rootDirectory, mono: true },
    { label: t("vercel.settings.buildCommand"), value: project.buildCommand, mono: true },
    { label: t("vercel.settings.installCommand"), value: project.installCommand, mono: true },
    { label: t("vercel.settings.devCommand"), value: project.devCommand, mono: true },
    { label: t("vercel.settings.outputDirectory"), value: project.outputDirectory, mono: true },
    { label: t("vercel.settings.region"), value: project.serverlessFunctionRegion },
    { label: t("vercel.settings.productionBranch"), value: project.link?.productionBranch },
    {
      label: t("vercel.settings.repository"),
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
        {value || t("vercel.settings.default")}
      </dd>
    </div>
  );
}
