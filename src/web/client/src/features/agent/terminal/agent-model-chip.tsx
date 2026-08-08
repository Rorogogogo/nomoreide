import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { AgentChatProviderInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { AgentModelChoices } from "./agent-model-choices";
import { agentModelLabel } from "./agent-model-options";

/**
 * Which model the session in front of the user runs on, where chat apps put it
 * — top of the conversation, one click from changing it. Reads as a quiet chip
 * until opened; the choice it changes is the provider's pin, so it applies to
 * the next session rather than retargeting the running one (a live CLI can't be
 * moved between models mid-conversation from the outside).
 */
export function AgentModelChip({
  onSelect,
  pinned,
  provider,
}: {
  onSelect: (model: string | null) => void;
  pinned: string | undefined;
  provider: AgentChatProviderInfo["id"];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    bottom?: number;
    right: number;
    top?: number;
  }>({ right: 8, top: 8 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const placeMenu = () => {
      const trigger = rootRef.current?.getBoundingClientRect();
      const menu = menuRef.current?.getBoundingClientRect();
      if (!trigger || !menu) return;
      const gap = 4;
      const viewportPadding = 8;
      const availableBelow =
        window.innerHeight - trigger.bottom - gap - viewportPadding;
      const maximumRight = Math.max(
        viewportPadding,
        window.innerWidth - menu.width - viewportPadding,
      );
      const right = Math.min(
        Math.max(viewportPadding, window.innerWidth - trigger.right),
        maximumRight,
      );
      setPosition(
        menu.height <= availableBelow
          ? { right, top: trigger.bottom + gap }
          : { bottom: window.innerHeight - trigger.top + gap, right },
      );
    };
    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);

  const label = agentModelLabel(provider, pinned) ?? t("dock.modelDefaultShort");

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("dock.modelChipAria", { model: label })}
        className={cn(
          "flex h-7 max-w-28 items-center gap-1 rounded-sm px-1.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
        onClick={() => setOpen((value) => !value)}
        title={t("dock.modelChipAria", { model: label })}
        type="button"
      >
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70" />
      </button>
      {open
        ? createPortal(
            <div
              aria-label={t("dock.modelMenu")}
              className="fixed z-[100] w-56 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl"
              ref={menuRef}
              role="menu"
              style={position}
            >
              <p className="px-2 pb-1 pt-1 text-[10px] text-muted-foreground">
                {t("dock.modelAppliesToNew")}
              </p>
              <AgentModelChoices
                onSelect={(model) => {
                  setOpen(false);
                  onSelect(model);
                }}
                pinned={pinned}
                provider={provider}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
