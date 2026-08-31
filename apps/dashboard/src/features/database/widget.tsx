import { Database } from "lucide-react";
import {
  rowCap,
  WidgetId,
  WidgetLoading,
  WidgetMore,
  WidgetRow,
  WidgetRows,
  WidgetStat,
  WidgetStats,
} from "@/features/home/widget-grid";
import type { WidgetDefinition, WidgetRenderProps } from "@/features/home/widget-types";
import type { DatabaseConnection } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useHomeDatabaseSummary } from "./use-home-database-summary";

/**
 * Databases — and specifically, which of them you can currently write to.
 *
 * An inventory of registered connections would be the failure §7.2 of the design
 * doc describes: config that never changes is not news, and a landing page is
 * for what is true *now*. The fact that changes, and that costs something if you
 * forget it, is `writeUnlocked` — `core/db-write.ts` gates every write on it, so
 * an unlocked connection is a loaded gun left on the table. That is the number
 * this panel leads with, and the row it puts first.
 *
 * When nothing is unlocked the connections are still named, dimmed: a workbench
 * landing page saying which databases this machine is wired to is orientation,
 * not filler — but it reads as background, which is what it is.
 */
export const databasesWidget: WidgetDefinition = {
  id: "databases",
  titleKey: "home.widget.databases",
  icon: <Database />,
  span: 6,
  scope: "global",
  source: "fetch",
  page: "database",
  render: ({ height }) => <DatabaseSummary height={height} />,
};

/** Four connections names the exposure; the rest is the Database page. */
const ROW_CAP = 4;

function DatabaseSummary({ height }: Pick<WidgetRenderProps, "height">) {
  const t = useT();
  const { connections, loaded, total, unlocked } = useHomeDatabaseSummary();
  const cap = rowCap(height, ROW_CAP);

  if (!loaded) return <WidgetLoading label={t("common.loading")} />;

  // Unlocked first — the only ordering that matters here, since everything else
  // on this list is inert until someone unlocks it.
  const rows = [...connections].sort(
    (a, b) => Number(b.writeUnlocked) - Number(a.writeUnlocked) || a.name.localeCompare(b.name),
  );

  return (
    <>
      <WidgetStats>
        <WidgetStat
          label={t("home.databases.unlocked")}
          tone="bad"
          value={unlocked}
        />
        <WidgetStat label={t("home.databases.registered")} value={total} />
      </WidgetStats>
      {rows.length === 0 ? null : (
        <WidgetRows>
          {rows.slice(0, cap).map((connection) => (
            <WidgetRow
              key={connection.name}
              meta={meta(connection, t)}
              name={connection.name}
              tone={connection.writeUnlocked ? "bad" : "idle"}
            />
          ))}
          {rows.length > cap ? (
            <WidgetMore>{t("home.more", { count: rows.length - cap })}</WidgetMore>
          ) : null}
        </WidgetRows>
      )}
    </>
  );
}

/**
 * An unlocked connection spends its words saying so; a locked one just names its
 * engine, which is the one thing about it worth knowing at a glance.
 */
function meta(connection: DatabaseConnection, t: ReturnType<typeof useT>) {
  if (connection.writeUnlocked) return t("home.databases.writeUnlocked");
  return <WidgetId>{connection.engine}</WidgetId>;
}
