import { useCallback, useRef } from "react";
import { Moon, Sun } from "lucide-react";
import {
  headerActionClassName,
  headerActionIconClassName,
  headerActionLabelClassName,
} from "@/components/header-action";
import { useTheme, type Theme } from "@/lib/theme";
import { useT } from "@/lib/i18n";

export function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useTheme();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const btn = buttonRef.current;
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { ready: Promise<void> };
    };

    if (!btn || !doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTheme(next);
      return;
    }

    const rect = btn.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const transition = doc.startViewTransition(() => {
      setTheme(next);
    });

    void transition.ready.then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${endRadius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 500,
          easing: "ease-in-out",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    });
  }, [theme]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={toggle}
      title={theme === "dark" ? t("action.toLight") : t("action.toDark")}
      aria-label={t("action.theme")}
      className={headerActionClassName()}
    >
      <span className={headerActionIconClassName()}>
        {theme === "dark" ? <Sun /> : <Moon />}
      </span>
      <span className={headerActionLabelClassName()}>{t("action.theme")}</span>
    </button>
  );
}
