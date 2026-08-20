import { Filter, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  ColumnInfo,
  RowFilter,
  RowFilterOperator,
} from "@/lib/api";
import { useT, type TranslationKey } from "@/lib/i18n";

const UNARY_OPERATORS = new Set<RowFilterOperator>(["isNull", "isNotNull"]);

export function DatabaseRowFilters({
  columns,
  filters,
  onChange,
}: {
  columns: ColumnInfo[];
  filters: RowFilter[];
  onChange: (filters: RowFilter[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [column, setColumn] = useState(columns[0]?.name ?? "");
  const selectedColumn = columns.find((candidate) => candidate.name === column) ?? columns[0];
  const operators = useMemo(
    () => operatorsForColumn(selectedColumn),
    [selectedColumn],
  );
  const [operator, setOperator] = useState<RowFilterOperator>(operators[0] ?? "eq");
  const [value, setValue] = useState("");
  const unary = UNARY_OPERATORS.has(operator);

  useEffect(() => {
    if (!columns.some((candidate) => candidate.name === column)) {
      setColumn(columns[0]?.name ?? "");
    }
  }, [column, columns]);

  useEffect(() => {
    if (!operators.includes(operator)) setOperator(operators[0] ?? "eq");
  }, [operator, operators]);

  function addFilter() {
    if (!column || filters.length >= 8 || (!unary && value.length === 0)) return;
    const next = { column, operator, value: unary ? undefined : value };
    if (!filters.some((filter) => filterKey(filter) === filterKey(next))) {
      onChange([...filters, next]);
    }
    setValue("");
  }

  return (
    <div className="shrink-0 border-b border-border bg-muted/10">
      <div className="flex min-h-8 flex-wrap items-center gap-1 px-2 py-1">
        <Button
          aria-expanded={open}
          className="h-6 gap-1 px-1.5 text-[10px]"
          onClick={() => setOpen((current) => !current)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Filter aria-hidden="true" className="size-3" />
          {t("database.filter.action")}
          {filters.length > 0 ? <span className="tabular-nums">{filters.length}</span> : null}
        </Button>
        {filters.map((filter, index) => (
          <span
            className="flex h-6 max-w-64 items-center gap-1 rounded border border-border bg-background px-1.5 font-mono text-[9px]"
            key={filterKey(filter)}
            title={filterLabel(filter, t)}
          >
            <span className="truncate">{filterLabel(filter, t)}</span>
            <button
              aria-label={t("database.filter.remove", { filter: filterLabel(filter, t) })}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => onChange(filters.filter((_, candidate) => candidate !== index))}
              type="button"
            >
              <X aria-hidden="true" className="size-2.5" />
            </button>
          </span>
        ))}
        {filters.length > 1 ? (
          <Button
            className="h-6 px-1.5 text-[10px] text-muted-foreground"
            onClick={() => onChange([])}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("database.filter.clear")}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 px-2 py-1.5">
          <select
            aria-label={t("database.filter.column")}
            className="h-7 min-w-28 rounded border border-border bg-background px-1.5 font-mono text-[10px]"
            onChange={(event) => setColumn(event.target.value)}
            value={column}
          >
            {columns.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>{candidate.name}</option>
            ))}
          </select>
          <select
            aria-label={t("database.filter.operator")}
            className="h-7 rounded border border-border bg-background px-1.5 text-[10px]"
            onChange={(event) => setOperator(event.target.value as RowFilterOperator)}
            value={operator}
          >
            {operators.map((candidate) => (
              <option key={candidate} value={candidate}>{t(`database.filter.operator.${candidate}` as TranslationKey)}</option>
            ))}
          </select>
          {!unary ? (
            <input
              aria-label={t("database.filter.value")}
              className="h-7 min-w-36 flex-1 rounded border border-border bg-background px-2 font-mono text-[10px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
              maxLength={2000}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addFilter();
              }}
              placeholder={t("database.filter.value")}
              value={value}
            />
          ) : null}
          <Button
            className="h-7 gap-1 px-2 text-[10px]"
            disabled={filters.length >= 8 || (!unary && value.length === 0)}
            onClick={addFilter}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" className="size-3" />
            {t("database.filter.add")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function operatorsForColumn(column: ColumnInfo | undefined): RowFilterOperator[] {
  const type = column?.dataType.toLowerCase() ?? "";
  const nullable: RowFilterOperator[] = column?.nullable ? ["isNull", "isNotNull"] : [];
  if (/char|text|clob|uuid|json|enum/.test(type)) {
    return ["eq", "neq", "contains", "startsWith", "endsWith", ...nullable];
  }
  if (/int|numeric|decimal|real|float|double|date|time|year/.test(type)) {
    return ["eq", "neq", "gt", "gte", "lt", "lte", ...nullable];
  }
  return ["eq", "neq", ...nullable];
}

function filterLabel(filter: RowFilter, t: ReturnType<typeof useT>): string {
  const operator = t(`database.filter.operator.${filter.operator}` as TranslationKey);
  return filter.value === undefined
    ? `${filter.column} ${operator}`
    : `${filter.column} ${operator} ${filter.value}`;
}

function filterKey(filter: RowFilter): string {
  return JSON.stringify([filter.column, filter.operator, filter.value]);
}
