import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Inbox, Search, SlidersHorizontal } from "lucide-react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import type { ErrorIncident } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  activeIncidentFilterCount,
  filterIncidents,
  incidentFilterOptions,
  type IncidentFilters,
} from "./incident-filters";
import { IncidentDetail } from "./incident-detail";
import { IncidentFilterPanel } from "./incident-filter-panel";

export interface IncidentTableProps {
  incidents: ErrorIncident[];
  connected: boolean;
  error?: string | null;
  onReviewChanges?: (sessionId: string) => void;
}

function toggled<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

export function IncidentTable({
  connected,
  error,
  incidents,
  onReviewChanges,
}: IncidentTableProps) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<IncidentFilters>(() => ({
    levels: [],
    services: [],
  }));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();
  const t = useT();

  const options = useMemo(() => incidentFilterOptions(incidents), [incidents]);
  const visibleIncidents = useMemo(
    () => filterIncidents(incidents, query, filters),
    [filters, incidents, query],
  );
  const activeFilterCount = activeIncidentFilterCount(filters);
  const clearFilters = () => {
    setQuery("");
    setFilters({ levels: [], services: [] });
  };
  const motionTransition = reduceMotion ? { duration: 0 } : { duration: 0.16 };

  return (
    <section className="flex h-full min-h-0 flex-col bg-card/85">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Inbox className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("errors.incidents")}</h2>
          <Badge appearance="outline" size="small" variant="outline">
            {t("errors.summary", { count: incidents.length })}
          </Badge>
        </div>
        <Badge
          appearance="outline"
          icon={
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                connected ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/60",
              )}
            />
          }
          size="small"
          variant="outline"
        >
          {connected ? t("errors.live") : t("errors.reconnecting")}
        </Badge>
      </header>

      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t("errors.searchAria")}
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("errors.searchPlaceholder")}
              type="search"
              value={query}
            />
          </div>
          <Button
            aria-expanded={filtersOpen}
            aria-label={t(filtersOpen ? "errors.hideFilters" : "errors.showFilters")}
            onClick={() => setFiltersOpen((current) => !current)}
            size="sm"
            type="button"
            variant="outline"
          >
            <SlidersHorizontal />
            {t("errors.filters")}
            {activeFilterCount > 0 ? (
              <Badge appearance="solid" size="small" variant="primary">
                {activeFilterCount}
              </Badge>
            ) : null}
          </Button>
        </div>

        <IncidentFilterPanel
          activeCount={activeFilterCount}
          levels={options.levels}
          onClear={clearFilters}
          onToggleLevel={(level) =>
            setFilters((current) => ({
              ...current,
              levels: toggled(current.levels, level),
            }))
          }
          onToggleService={(service) =>
            setFilters((current) => ({
              ...current,
              services: toggled(current.services, service),
            }))
          }
          open={filtersOpen}
          query={query}
          reduceMotion={reduceMotion}
          selectedLevels={filters.levels}
          selectedServices={filters.services}
          services={options.services}
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("errors.resultCount", {
            shown: visibleIncidents.length,
            total: incidents.length,
          })}
        </p>
      </div>

      {error ? (
        <div className="shrink-0 px-4 pt-3">
          <Alert className="border-destructive/40 text-destructive" variant="muted">
            {t("errors.loadFailed", { error })}
          </Alert>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-2 sm:p-4">
        {incidents.length === 0 ? (
          <EmptyState body={t("errors.emptyBody")} title={t("errors.emptyTitle")} />
        ) : visibleIncidents.length === 0 ? (
          <EmptyState body={t("errors.noMatchesBody")} title={t("errors.noMatchesTitle")}>
            <Button onClick={clearFilters} size="sm" type="button" variant="outline">
              {t("errors.clearFilters")}
            </Button>
          </EmptyState>
        ) : (
          <table
            aria-label={t("errors.tableAria")}
            className="w-full table-fixed border-collapse"
          >
            <thead className="hidden border-b border-border text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground md:table-header-group">
              <tr>
                <th className="w-24 px-3 py-2" scope="col">{t("errors.columnSeverity")}</th>
                <th className="w-36 px-3 py-2" scope="col">{t("errors.columnLatest")}</th>
                <th className="w-28 px-3 py-2" scope="col">{t("errors.columnService")}</th>
                <th className="px-3 py-2" scope="col">{t("errors.columnIncident")}</th>
                <th className="w-20 px-3 py-2" scope="col">{t("errors.columnCount")}</th>
                <th className="w-48 px-3 py-2" scope="col">{t("errors.columnSource")}</th>
                <th className="w-10 px-2 py-2" scope="col">
                  <span className="sr-only">{t("errors.columnActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleIncidents.map((incident) => {
                const expanded = incident.id === expandedId;
                const detailId = `incident-detail-${incident.id}`;
                return (
                  <Fragment key={incident.id}>
                    <tr
                      className="transition-colors hover:bg-muted/40 motion-reduce:transition-none"
                      data-incident-id={incident.id}
                    >
                      <td className="w-24 px-2 py-3 align-middle md:px-3">
                        <Badge
                          appearance="subtle"
                          size="small"
                          variant={incident.level === "error" ? "danger" : "warning"}
                        >
                          {t(
                            incident.level === "error"
                              ? "errors.level.error"
                              : "errors.level.warning",
                          )}
                        </Badge>
                      </td>
                      <td className="hidden px-3 py-3 align-middle font-mono text-[11px] text-muted-foreground md:table-cell">
                        {new Date(incident.lastSeen).toLocaleString()}
                      </td>
                      <td className="hidden truncate px-3 py-3 align-middle font-mono text-xs font-semibold md:table-cell">
                        {incident.service}
                      </td>
                      <td className="min-w-0 px-2 py-3 align-middle md:px-3">
                        <p className="truncate text-xs font-medium">{incident.title}</p>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground md:hidden">
                          {incident.service} · {new Date(incident.lastSeen).toLocaleString()}
                        </p>
                      </td>
                      <td className="hidden px-3 py-3 align-middle font-mono text-xs text-muted-foreground md:table-cell">
                        ×{incident.count}
                      </td>
                      <td className="hidden truncate px-3 py-3 align-middle font-mono text-[11px] text-muted-foreground md:table-cell">
                        {incident.file
                          ? `${incident.file}${incident.line ? `:${incident.line}` : ""}`
                          : t("common.none")}
                      </td>
                      <td className="w-10 px-2 py-3 align-middle">
                        <Button
                          aria-controls={detailId}
                          aria-expanded={expanded}
                          aria-label={t(
                            expanded ? "errors.collapseIncident" : "errors.expandIncident",
                            { title: incident.title },
                          )}
                          onClick={() => setExpandedId(expanded ? null : incident.id)}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <ChevronDown
                            className={cn(
                              "transition-transform motion-reduce:transition-none",
                              expanded && "rotate-180",
                            )}
                          />
                        </Button>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr>
                        <td className="p-0" colSpan={7}>
                          <motion.div
                            animate={{ opacity: 1, y: 0 }}
                            initial={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
                            transition={motionTransition}
                          >
                          <IncidentDetail
                            detailId={detailId}
                            incident={incident}
                            onReviewChanges={onReviewChanges}
                          />
                          </motion.div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function EmptyState({
  body,
  children,
  title,
}: {
  body: string;
  children?: ReactNode;
  title: string;
}) {
  return (
    <div className="flex min-h-64 items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Inbox className="mx-auto size-8 text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{body}</p>
        {children ? <div className="mt-4">{children}</div> : null}
      </div>
    </div>
  );
}
