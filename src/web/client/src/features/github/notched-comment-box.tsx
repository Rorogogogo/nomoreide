import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";

/**
 * A comment textarea whose bottom-right corner is notched out so an action
 * button nestles into it — the field's own edge steps inward (凹进去) around the
 * button instead of the button sitting on top of the field. The notch is carved
 * with `clip-path: path()` and the matching rounded border is drawn as an SVG
 * outline, so both stay smooth and hug the button tightly. Box + button are
 * measured so the notch fits any button label.
 */

const GAP = 6; // breathing room between the notch edge and the button, all sides
const R = 6; // outer corner radius (matches rounded-md)
const CR = 8; // concave radius where the notch turns in

function buildNotchPath(w: number, h: number, nw: number, nh: number): string {
  const r = Math.max(0, Math.min(R, w / 2, h / 2));
  const cr = Math.max(0, Math.min(CR, nw - r, nh - r));
  return [
    `M ${r} 0`,
    `H ${w - r}`,
    `A ${r} ${r} 0 0 1 ${w} ${r}`, // top-right
    `V ${h - nh - r}`,
    `A ${r} ${r} 0 0 1 ${w - r} ${h - nh}`, // notch top, turning left
    `H ${w - nw + cr}`,
    `A ${cr} ${cr} 0 0 0 ${w - nw} ${h - nh + cr}`, // concave inner corner
    `V ${h - r}`,
    `A ${r} ${r} 0 0 1 ${w - nw - r} ${h}`, // bottom of notch, turning left
    `H ${r}`,
    `A ${r} ${r} 0 0 1 0 ${h - r}`, // bottom-left
    `V ${r}`,
    `A ${r} ${r} 0 0 1 ${r} 0`, // top-left
    "Z",
  ].join(" ");
}

export function NotchedCommentBox({
  value,
  onChange,
  placeholder,
  rows = 3,
  action,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  action: ReactNode;
}) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [notch, setNotch] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const boxEl = boxRef.current;
    const actionEl = actionRef.current;
    if (!boxEl || !actionEl) return;
    const measure = () => {
      setBox({ w: boxEl.clientWidth, h: boxEl.clientHeight });
      setNotch({ w: actionEl.offsetWidth + GAP * 2, h: actionEl.offsetHeight + GAP * 2 });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(boxEl);
    observer.observe(actionEl);
    return () => observer.disconnect();
  }, []);

  const path =
    box && notch.w && notch.h ? buildNotchPath(box.w, box.h, notch.w, notch.h) : null;

  return (
    <div className="relative" ref={boxRef}>
      <textarea
        className="peer block w-full resize-none bg-background px-3 pt-2 font-mono text-[12px] placeholder:text-muted-foreground focus:outline-none"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{
          clipPath: path ? `path('${path}')` : undefined,
          paddingBottom: notch.h || 44,
        }}
        value={value}
      />
      {box && path ? (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-visible text-border transition-colors peer-focus:text-foreground/40"
          fill="none"
          height={box.h}
          viewBox={`0 0 ${box.w} ${box.h}`}
          width={box.w}
        >
          <title>{t("github.commentBorderTitle")}</title>
          <path d={path} stroke="currentColor" strokeWidth={1} />
        </svg>
      ) : null}
      <div className="absolute" ref={actionRef} style={{ bottom: GAP, right: GAP }}>
        {action}
      </div>
    </div>
  );
}
