import { History } from "lucide-react";
import {
  rowCap,
  WidgetLoading,
  WidgetMore,
  WidgetRow,
  WidgetRows,
  WidgetStat,
  WidgetStats,
} from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import { useT } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/utils";
import { useHomeSnapshotSummary } from "./use-home-snapshot-summary";

/**
 * Snapshots — how far back you can undo.
 *
 * The question this answers on a landing page is the one you want answered
 * *before* you let an agent loose on the tree, not after: is there a restore
 * point, and how old is it. "30 snapshots" alone would fail the rule in §7.2 of
 * the design doc, so the panel splits out how many were taken in the last day
 * and then names the newest few.
 *
 * Repo-scoped, like Repository: `/api/snapshots` reads whatever the repository
 * picker has selected.
 */
export const snapshotsWidget: WidgetDefinition = {
  id: "snapshots",
  titleKey: "home.widget.snapshots",
  icon: <History />,
  span: 6,
  scope: "repo",
  source: "fetch",
  page: "git",
  render: ({ height }) => <SnapshotSummary height={height} />,
};

/** Four restore points is the shape of the recent past; the rest is the page. */
const ROW_CAP = 4;

function SnapshotSummary({ height }: Pick<WidgetRenderProps, "height">) {
  const t = useT();
  const { loaded, recent, snapshots, total } = useHomeSnapshotSummary();
  const cap = rowCap(height, ROW_CAP);

  if (!loaded) return <WidgetLoading label={t("common.loading")} />;

  return (
    <>
      <WidgetStats>
        <WidgetStat
          label={t("home.snapshots.recent")}
          tone="ok"
          value={recent}
        />
        <WidgetStat label={t("home.snapshots.total")} value={total} />
      </WidgetStats>
      {snapshots.length === 0 ? null : (
        <WidgetRows>
          {snapshots.slice(0, cap).map((snapshot) => (
            <WidgetRow
              key={snapshot.sha}
              meta={snapshot.label}
              /*
                The sha is the identifier and the label is prose, so they take
                the mono and sans cells respectively — the split `WidgetRow`
                documents. Seven characters is git's own abbreviation.
              */
              name={snapshot.sha.slice(0, 7)}
              trailing={formatRelativeTime(snapshot.createdAt)}
            />
          ))}
          {snapshots.length > cap ? (
            <WidgetMore>{t("home.more", { count: snapshots.length - cap })}</WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}
