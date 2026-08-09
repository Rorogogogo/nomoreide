import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import {
  exportDatabaseObject,
  type DatabaseExportFormat,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

export function DatabaseExportMenu({
  connection,
  objectKey,
  qualifiedName,
}: {
  connection: string;
  objectKey: string;
  qualifiedName: string;
}) {
  const t = useT();
  const { error: showError, success: showSuccess } = useToasts();
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState<DatabaseExportFormat | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  async function startExport(format: DatabaseExportFormat) {
    setOpen(false);
    setExporting(format);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${sanitizeFilename(connection)}-${sanitizeFilename(qualifiedName)}-${date}.${format}`;
      const result = await exportDatabaseObject(connection, objectKey, format, filename, {
        signal: controller.signal,
      });
      if (result.delivery === "browser") {
        startBrowserDownload(result.url);
        showSuccess(t("database.export.started", { format: format.toUpperCase() }));
      } else if (result.delivery === "file") {
        showSuccess(t("database.export.completed", { count: result.rowsWritten }));
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        showError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current) setExporting(null);
    }
  }

  if (exporting) {
    return (
      <Button
        aria-label={t("database.export.cancel")}
        className="ml-auto h-6 gap-1 px-1.5 text-[10px]"
        onClick={() => abortRef.current?.abort()}
        size="sm"
        title={t("database.export.cancel")}
        type="button"
        variant="ghost"
      >
        <Loader2 className="size-3 animate-spin" />
        <span className="hidden sm:inline">{t("database.export.stop")}</span>
      </Button>
    );
  }

  return (
    <div className="relative ml-auto" ref={rootRef}>
      <Button
        aria-label={t("database.export.action")}
        aria-expanded={open}
        className="h-6 gap-1 px-1.5 text-[10px]"
        onClick={() => setOpen((value) => !value)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <Download className="size-3" />
        <span className="hidden sm:inline">{t("database.export.action")}</span>
        <ChevronDown className="size-3" />
      </Button>
      {open ? (
        <div
          className="absolute right-0 top-full z-40 mt-1 w-52 rounded-md border border-border bg-card p-1 shadow-md"
        >
          {(["csv", "json"] as const).map((format) => (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
              key={format}
              onClick={() => void startExport(format)}
              type="button"
            >
              <Download className="size-3.5 text-muted-foreground" />
              {t("database.export.allAs", { format: format.toUpperCase() })}
            </button>
          ))}
          <p className="border-t border-border px-2 pt-1.5 text-[10px] leading-4 text-muted-foreground">
            {t("database.export.maskedHint")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function sanitizeFilename(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "database";
}

function startBrowserDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
