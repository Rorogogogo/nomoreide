import { GitBranch } from "lucide-react";
import {
  WidgetId,
  WidgetMore,
  WidgetNote,
  WidgetRow,
  WidgetRows,
  WidgetStat,
  WidgetStats,
  type WidgetTone,
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
  page: "git",
  render: ({ data }) => <RepositorySummary data={data} />,
};

/** Five paths names the change; more and the panel is the Git page. */
const FILE_CAP = 5;

function RepositorySummary({ data }: WidgetRenderProps) {
  const t = useT();
  const { selectedRepository, status } = data.git;

  if (!status) {
    return <WidgetNote>{data.git.error ?? t("home.repository.none")}</WidgetNote>;
  }

  const staged = status.files.filter((file) => file.index !== " " && file.index !== "?").length;

  return (
    <>
      <WidgetStats>
        <WidgetStat
          label={t("home.repository.changedLabel")}
          tone={status.files.length > 0 ? "warn" : "ok"}
          value={status.files.length}
        />
        <WidgetStat label={t("home.repository.staged")} value={staged} />
        <WidgetStat
          label={t("home.repository.ahead")}
          tone={status.ahead > 0 ? "warn" : "idle"}
          value={status.ahead}
        />
        <WidgetStat
          label={t("home.repository.behind")}
          tone={status.behind > 0 ? "warn" : "idle"}
          value={status.behind}
        />
      </WidgetStats>
      <WidgetRow
        meta={selectedRepository?.name}
        name={status.branch}
        trailing={status.upstream ?? t("home.repository.noUpstream")}
      />
      {status.files.length === 0 ? (
        <WidgetNote>{t("home.repository.clean")}</WidgetNote>
      ) : (
        <WidgetRows>
          {status.files.slice(0, FILE_CAP).map((file) => (
            <WidgetRow
              key={file.path}
              meta={<WidgetId>{file.path}</WidgetId>}
              name={statusCode(file)}
              tone={fileTone(file)}
            />
          ))}
          {status.files.length > FILE_CAP ? (
            <WidgetMore>
              {t("home.more", { count: status.files.length - FILE_CAP })}
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
