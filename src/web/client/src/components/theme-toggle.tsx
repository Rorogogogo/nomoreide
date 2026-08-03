import { useCallback, useRef, type MouseEvent } from "react";
import { Moon, Sun } from "lucide-react";
import {
  headerActionClassName,
  headerActionIconClassName,
} from "@/components/header-action";
import { Tooltip } from "@/components/ui/tooltip";
import { useResolvedTheme, useTheme, type Theme } from "@/lib/theme";
import { useT } from "@/lib/i18n";

export function ThemeToggle() {
  const t = useT();
  const [, setTheme] = useTheme();
  const resolvedTheme = useResolvedTheme();
  const originRef = useRef<HTMLSpanElement>(null);

  const toggle = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const next: Theme = resolvedTheme === "dark" ? "light" : "dark";
    const origin = originRef.current;
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => {
        ready: Promise<void>;
        finished: Promise<void>;
      };
    };

    if (!origin || !doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTheme(next);
      return;
    }

    const rect = origin.getBoundingClientRect();
    const activatedByPointer = event.detail > 0;
    const x = activatedByPointer ? event.clientX : rect.left + rect.width / 2;
    const y = activatedByPointer ? event.clientY : rect.top + rect.height / 2;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const endRadius = Math.hypot(
      Math.max(x, viewportWidth - x),
      Math.max(y, viewportHeight - y),
    ) + 2;

    /*
     * Describe the reveal in percentages, never absolute pixels.
     *
     * `clip-path` percentages resolve against the pseudo-element's own box, and
     * on the *first* view transition of a page Chrome hands back a
     * `::view-transition-new(root)` box measured in device pixels rather than
     * CSS pixels. On a 2x display that halves an absolute `circle(… at 1450px
     * 27px)` to (725, 13) — the middle of the top edge instead of the button —
     * and halves the radius too, so the reveal stops ~79% of the way across and
     * the remainder snaps when the pseudo-element is torn down. Every later
     * transition uses CSS pixels and looks correct, which is why only the first
     * click misbehaved. Percentages scale the centre and the radius together,
     * so the reveal is identical whichever units the box turns out to be in.
     *
     * A percentage radius resolves against `hypot(width, height) / sqrt(2)` of
     * that box, per CSS Shapes.
     */
    const referenceRadius = Math.hypot(viewportWidth, viewportHeight) / Math.SQRT2;
    const originX = `${(x / viewportWidth) * 100}%`;
    const originY = `${(y / viewportHeight) * 100}%`;
    const endRadiusPercent = `${(endRadius / referenceRadius) * 100}%`;

    const root = document.documentElement;
    root.style.setProperty("--theme-transition-x", originX);
    root.style.setProperty("--theme-transition-y", originY);
    root.classList.add("theme-transition");

    const transition = doc.startViewTransition(() => {
      setTheme(next);
    });

    const cleanup = () => {
      root.classList.remove("theme-transition");
      root.style.removeProperty("--theme-transition-x");
      root.style.removeProperty("--theme-transition-y");
    };
    void transition.finished.then(cleanup, cleanup);

    void transition.ready.then(() => {
      root.animate(
        {
          clipPath: [
            `circle(0% at ${originX} ${originY})`,
            `circle(${endRadiusPercent} at ${originX} ${originY})`,
          ],
        },
        {
          duration: 500,
          easing: "cubic-bezier(0.4, 0, 0.2, 1)",
          fill: "forwards",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    });
  }, [resolvedTheme, setTheme]);

  return (
    <Tooltip align="end" label={resolvedTheme === "dark" ? t("action.toLight") : t("action.toDark")}>
      <button
        type="button"
        onClick={toggle}
        aria-label={t("action.theme")}
        className={headerActionClassName()}
      >
        <span ref={originRef} className={headerActionIconClassName()}>
          {resolvedTheme === "dark" ? <Sun /> : <Moon />}
        </span>
      </button>
    </Tooltip>
  );
}
