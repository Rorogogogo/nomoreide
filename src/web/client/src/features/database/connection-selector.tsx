import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Database, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { DatabaseConnection } from "@/lib/api";

/**
 * Connection picker that lives in the header (mirrors the git RepositorySelector)
 * so browsing no longer costs a permanent sidebar lane.
 */
export function ConnectionSelector({
  connections,
  selected,
  onSelect,
  onAdd,
  onEdit,
  onRemove,
}: {
  connections: DatabaseConnection[];
  selected: string | null;
  onSelect: (name: string) => void;
  onAdd: () => void;
  onEdit: (connection: DatabaseConnection) => void;
  onRemove: (name: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const current = connections.find((c) => c.name === selected);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  return (
    <div className="relative z-50 flex items-center gap-2" ref={containerRef}>
      <Button
        className="max-w-[240px] justify-start gap-2 rounded-md border-border bg-card"
        onClick={() => setOpen((value) => !value)}
        size="sm"
        type="button"
        variant="outline"
      >
        <Database className="text-muted-foreground" />
        <span className="truncate">{current?.name ?? t("database.selectConnection")}</span>
        {current ? (
          <Badge variant="outline" size="small">
            {current.engine}
          </Badge>
        ) : null}
        <ChevronDown className={cn("ml-auto transition-transform", open && "rotate-180")} />
      </Button>

      {open ? (
        <div className="absolute right-0 top-10 z-50 w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Database className="size-3.5 text-muted-foreground" />
            <div className="text-xs font-semibold">{t("database.connections")}</div>
            <Badge className="ml-auto" variant="outline" size="small">
              {connections.length}
            </Badge>
          </div>

          <div className="max-h-72 overflow-auto">
            {connections.length ? (
              <div className="divide-y divide-border">
                {connections.map((connection) => {
                  const isSelected = connection.name === selected;
                  return (
                    <div
                      className={cn(
                        "group grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted",
                        isSelected && "bg-muted/70",
                      )}
                      key={connection.name}
                    >
                      <button
                        className="min-w-0 text-left"
                        onClick={() => {
                          onSelect(connection.name);
                          setOpen(false);
                        }}
                        type="button"
                      >
                        <span className="block truncate text-sm font-medium leading-tight">
                          {connection.name}
                        </span>
                        <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground">
                          {connection.url}
                        </span>
                      </button>
                      {isSelected ? (
                        <Check className="size-3.5" />
                      ) : (
                        <span className="size-3.5" />
                      )}
                      <Button
                        aria-label={t("database.editConn", { name: connection.name })}
                        className="size-6 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => {
                          onEdit(connection);
                          setOpen(false);
                        }}
                        size="icon"
                        title={t("database.editConn", { name: connection.name })}
                        type="button"
                        variant="ghost"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        aria-label={t("database.removeConn", { name: connection.name })}
                        className="size-6 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => onRemove(connection.name)}
                        size="icon"
                        title={t("database.removeConn", { name: connection.name })}
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t("database.noSavedConnections")}
              </div>
            )}
          </div>

          <div className="border-t border-border bg-muted/20 p-2">
            <Button
              className="w-full"
              onClick={() => {
                onAdd();
                setOpen(false);
              }}
              size="sm"
              type="button"
            >
              <Plus className="size-3" />
              {t("database.addConnection")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
