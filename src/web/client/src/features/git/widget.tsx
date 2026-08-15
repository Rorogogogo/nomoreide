import { GitBranch } from "lucide-react";
import { WidgetFigure, WidgetNote } from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import { useT } from "@/lib/i18n";

/**
 * Repository — the one repo-scoped widget in stage 1.
 *
 * It names the repository it is reporting on rather than assuming the reader
 * knows which one the picker has selected. Home is global; a repo-scoped widget
 * that showed a bare "3 changed" would be ambiguous the moment more than one
 * project is registered.
 */
export const repositoryWidget: WidgetDefinition = {
  id: "repository",
  titleKey: "home.widget.repository",
  icon: <GitBranch />,
  span: 6,
  scope: "repo",
  page: "git",
  render: ({ data }) => <RepositorySummary data={data} />,
};

function RepositorySummary({ data }: WidgetRenderProps) {
  const t = useT();
  const { selectedRepository, status } = data.git;

  if (!status) {
    return <WidgetNote>{data.git.error ?? t("home.repository.none")}</WidgetNote>;
  }

  const sync =
    status.ahead > 0 || status.behind > 0
      ? t("home.repository.sync", {
          ahead: String(status.ahead),
          behind: String(status.behind),
        })
      : null;

  return (
    <>
      <WidgetFigure>{status.files.length}</WidgetFigure>
      <WidgetNote>
        {status.files.length === 0 ? t("home.repository.clean") : t("home.repository.changed")}
      </WidgetNote>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
          {status.branch}
        </code>
        {selectedRepository ? <span className="truncate">{selectedRepository.name}</span> : null}
        {sync ? <span className="tabular-nums">{sync}</span> : null}
      </span>
    </>
  );
}
