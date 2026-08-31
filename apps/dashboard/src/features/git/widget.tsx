import { GitBranch } from "lucide-react";
import {
  rowCap,
  type WidgetTone,
  WidgetId,
  WidgetMore,
  WidgetNote,
  WidgetRow,
  WidgetRows,
  WidgetStat,
  WidgetStats,
} from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import type { GitFileStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * Repository — the one repo-scoped widget in stage 1.
 *
 * It names the repository and branch it is reporting on rather than assuming
 * the reader knows what the picker has selected. Home is global; a repo-scoped
 * widget showing a bare "3 changed" would be ambiguous the moment more than one
 * project is registered.
 *
 * The counters are ahead/behind/changed because those are the three numbers
 * that decide whether you need to do something before you can push.
 */
export const repositoryWidget: WidgetDefinition = {
  id: "repository",
  titleKey: "home.widget.repository",
  icon: <GitBranch />,
  span: 6,
  scope: "repo",
  source: "dashboard",
  page: "git",
  render: ({ data, height }) => <RepositorySummary data={data} height={height} />,
};

/** Five paths names the change; more and the panel is the Git page. */
const FILE_CAP = 5;

function RepositorySummary({ data, height }: Pick<WidgetRenderProps, "data" | "height">) {
  const t = useT();
  const { selectedRepository, status } = data.git;
  const cap = rowCap(height, FILE_CAP);

  if (!status) {
    return <WidgetNote>{data.git.error ?? t("home.repository.none")}</WidgetNote>;
  }

  const staged = status.files.filter((file) => file.index !== " " && file.index !== "?").length;

  return (
    <>
      <WidgetStats>
        <WidgetStat
          label={t("home.repository.changedLabel")}
          tone="warn"
          value={status.files.length}
        />
        <WidgetStat label={t("home.repository.staged")} tone="ok" value={staged} />
        <WidgetStat label={t("home.repository.ahead")} tone="warn" value={status.ahead} />
        <WidgetStat label={t("home.repository.behind")} tone="warn" value={status.behind} />
      </WidgetStats>
      <WidgetRow
        meta={selectedRepository?.name}
        name={status.branch}
        trailing={status.upstream ?? t("home.repository.noUpstream")}
      />
      {status.files.length === 0 ? null : (
        <WidgetRows>
          {status.files.slice(0, cap).map((file) => (
            <WidgetRow
              key={file.path}
              meta={<WidgetId>{file.path}</WidgetId>}
              name={statusCode(file)}
              tone={fileTone(file)}
            />
          ))}
          {status.files.length > cap ? (
            <WidgetMore>
              {t("home.more", { count: status.files.length - cap })}
            </WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}

/**
 * Porcelain's two-column code, kept verbatim — `M ` and ` M` mean staged and
 * unstaged, and collapsing them to one letter would throw away the distinction
 * the staged counter above is about. Spaces render as `·` so the columns stay
 * legible in a proportional-width cell.
 */
function statusCode(file: GitFileStatus): string {
  const cell = (mark: string) => (mark === " " || mark === "" ? "·" : mark);
  return `${cell(file.index)}${cell(file.workingTree)}`;
}

function fileTone(file: GitFileStatus): WidgetTone {
  if (file.index === "?" || file.workingTree === "?") return "idle";
  if (file.workingTree === "D" || file.index === "D") return "bad";
  return file.index !== " " && file.index !== "" ? "ok" : "warn";
}
