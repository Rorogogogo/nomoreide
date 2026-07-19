import { Minus, Square, X } from "lucide-react";
import { isTauri, minimizeWindow, toggleMaximizeWindow, hideWindow, startDragging } from "@/lib/tauri";
import { useT } from "@/lib/i18n";

export function TauriTitleBar() {
  const t = useT();
  if (!isTauri()) return null;

  return (
    <div
      className="flex items-center justify-between h-8 bg-background border-b border-border select-none"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      onMouseDown={() => startDragging()}
    >
      <span className="px-3 text-xs font-medium text-muted-foreground">NoMoreIDE</span>
      <div
        className="flex items-center"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={minimizeWindow}
          className="h-8 w-10 flex items-center justify-center hover:bg-muted transition-colors"
          aria-label={t("common.minimize")}
        >
          <Minus className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={toggleMaximizeWindow}
          className="h-8 w-10 flex items-center justify-center hover:bg-muted transition-colors"
          aria-label={t("common.maximize")}
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={hideWindow}
          className="h-8 w-10 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground transition-colors"
          aria-label={t("common.close")}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
