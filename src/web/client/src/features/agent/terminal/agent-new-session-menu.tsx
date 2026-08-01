import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, SquareTerminal } from "lucide-react";
import type { AgentChatProviderOption } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { ClaudeLogo, CodexLogo } from "../agent-logos";

export function AgentNewSessionMenu({
  creating,
  onCreateAgent,
  onCreateShell,
  providers,
}: {
  creating: boolean;
  onCreateAgent: (provider: AgentChatProviderOption) => void;
  onCreateShell: () => void;
  providers: AgentChatProviderOption[];
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

  function toggle() {
    setOpen((value) => !value);
  }

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
      const desiredRight = window.innerWidth - trigger.right;
      const maximumRight = Math.max(
        viewportPadding,
        window.innerWidth - menu.width - viewportPadding,
      );
      const right = Math.min(
        Math.max(viewportPadding, desiredRight),
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
  }, [open, providers.length]);

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

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("dock.newSessionMenu")}
        className={cn(
          "grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
        onClick={toggle}
        type="button"
      >
        <Plus className="size-3.5" />
      </button>
      {open
        ? createPortal(
            <div
              aria-label={t("dock.newSessionMenu")}
              className="fixed z-[100] w-52 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl"
              ref={menuRef}
              role="menu"
              style={position}
            >
              {providers.map((provider) => {
                const ProviderLogo =
                  provider.id === "codex" ? CodexLogo : ClaudeLogo;
                return (
                  <button
                    aria-label={provider.label}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={creating || !provider.configured}
                    key={provider.id}
                    onClick={() => {
                      setOpen(false);
                      onCreateAgent(provider);
                    }}
                    role="menuitem"
                    title={
                      provider.configured
                        ? provider.label
                        : `${provider.label}${t("dock.notInstalledSuffix")}`
                    }
                    type="button"
                  >
                    <ProviderLogo className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {provider.label}
                    </span>
                    {!provider.configured ? (
                      <span className="text-[10px] text-muted-foreground">
                        {t("dock.notInstalledShort")}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              <div className="my-1 h-px bg-border" />
              <button
                aria-label={t("dock.shell")}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45"
                disabled={creating}
                onClick={() => {
                  setOpen(false);
                  onCreateShell();
                }}
                role="menuitem"
                type="button"
              >
                <SquareTerminal className="size-3.5 shrink-0" />
                <span className="font-medium">{t("dock.shell")}</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
