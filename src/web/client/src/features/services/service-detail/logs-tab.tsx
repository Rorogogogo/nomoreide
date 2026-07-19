import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { LogConsole } from "./log-console";

export function LogsTab({ serviceName }: { serviceName: string }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [hideStdout, setHideStdout] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const console = (
    <LogConsole
      fill
      hideStdout={hideStdout}
      query={query}
      setHideStdout={setHideStdout}
      setQuery={setQuery}
      setStreaming={setStreaming}
      streaming={streaming}
      target={{ kind: "service", name: serviceName }}
      trailing={
        <Button
          aria-label={fullscreen ? t("services.logsView.exitFs") : t("services.logsView.expand")}
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setFullscreen((value) => !value)}
          size="icon-sm"
          title={fullscreen ? t("services.fsExit") : t("services.fsExpand")}
          type="button"
          variant="ghost"
        >
          {fullscreen ? <Minimize2 /> : <Maximize2 />}
        </Button>
      }
    />
  );

  if (fullscreen) {
    return (
      <LogsOverlay onClose={() => setFullscreen(false)} title={t("services.logsTitle", { name: serviceName })}>
        {console}
      </LogsOverlay>
    );
  }
  // Give the inline console a real height to fill so the log list doesn't leave
  // dead space below it; `fill` then stretches the viewer to this box.
  return <div className="h-[60vh] min-h-[24rem]">{console}</div>;
}

/** Near-fullscreen portal used by both the single-service and multi-log views. */
export function LogsOverlay({
  title,
  onClose,
  children,
  maxWidthClass = "max-w-6xl",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  maxWidthClass?: string;
}) {
  const t = useT();
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[1000] bg-black/40 p-4 sm:p-8" onMouseDown={onClose}>
      <div
        aria-modal="true"
        className={`mx-auto flex h-full ${maxWidthClass} flex-col overflow-hidden rounded-lg border border-border bg-card text-xs shadow-xl`}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          <Button aria-label={t("services.closeLogs")} onClick={onClose} size="icon" type="button" variant="ghost">
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 p-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
