import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export function ComposerDialog({
  children,
  icon,
  onClose,
  title,
  size = "md",
}: {
  children: ReactNode;
  icon: ReactNode;
  onClose: () => void;
  title: string;
  size?: "md" | "lg" | "xl";
}) {
  const t = useT();
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[1000] grid place-items-center px-4">
      <button
        aria-label={t("services.closeDialog")}
        className="absolute inset-0 cursor-default bg-black/35"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <div
        aria-modal="true"
        className={`relative flex max-h-[min(820px,calc(100vh-2rem))] w-full flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl ${size === "xl" ? "max-w-[min(1400px,calc(100vw-2rem))]" : size === "lg" ? "max-w-3xl" : "max-w-lg"}`}
        role="dialog"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <div className="flex size-5 items-center justify-center text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0">
            {icon}
          </div>
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</h2>
          <Button
            aria-label={t("services.closeDialog")}
            className="size-7"
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
        </div>
        <div className="min-h-0 overflow-auto p-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
