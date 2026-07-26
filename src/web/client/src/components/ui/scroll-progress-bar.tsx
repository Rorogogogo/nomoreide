import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface ScrollProgressBarProps {
  type?: "circle" | "bar";
  position?: "top-right" | "bottom-right" | "top-left" | "bottom-left";
  color?: string;
  strokeSize?: number;
  showPercentage?: boolean;
}

function scrollPercentage(target: EventTarget | null) {
  const scroller =
    target === document
      ? document.scrollingElement
      : target instanceof Element
        ? target
        : null;

  if (!scroller) return null;

  const scrollableHeight = scroller.scrollHeight - scroller.clientHeight;
  if (scrollableHeight <= 0) return null;

  return Math.round((scroller.scrollTop / scrollableHeight) * 100);
}

export function ScrollProgressBar({
  type = "circle",
  position = "bottom-right",
  color = "hsl(var(--primary))",
  strokeSize = 2,
  showPercentage = false,
}: ScrollProgressBarProps) {
  const [percentage, setPercentage] = useState(0);

  useEffect(() => {
    const updateProgress = (event: Event) => {
      const nextPercentage = scrollPercentage(event.target);
      if (nextPercentage !== null) setPercentage(nextPercentage);
    };

    document.addEventListener("scroll", updateProgress, {
      capture: true,
      passive: true,
    });
    return () => document.removeEventListener("scroll", updateProgress, true);
  }, []);

  if (type === "bar") {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 z-[100]"
        style={{ height: `${strokeSize}px` }}
      >
        <motion.span
          animate={{ width: `${percentage}%` }}
          className="block h-full"
          initial={false}
          style={{
            backgroundColor: color,
            boxShadow: `0 0 8px ${color}`,
          }}
          transition={{ duration: 0.12, ease: "easeOut" }}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "pointer-events-none fixed z-[100] flex items-center justify-center",
        {
          "end-0 top-0": position === "top-right",
          "bottom-0 end-0": position === "bottom-right",
          "start-0 top-0": position === "top-left",
          "bottom-0 start-0": position === "bottom-left",
        },
      )}
    >
      {percentage > 0 ? (
        <>
          <svg aria-hidden="true" height="100" viewBox="0 0 100 100" width="100">
            <circle
              cx="50"
              cy="50"
              fill="none"
              r="30"
              stroke="hsl(var(--border))"
              strokeWidth={strokeSize}
            />
            <motion.circle
              animate={{ pathLength: percentage / 100 }}
              cx="50"
              cy="50"
              fill="none"
              initial={false}
              pathLength="1"
              r="30"
              stroke={color}
              strokeWidth={strokeSize}
              style={{ rotate: -90, transformOrigin: "center" }}
              transition={{ duration: 0.12, ease: "easeOut" }}
            />
          </svg>
          {showPercentage ? (
            <span className="absolute text-sm">{percentage}%</span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
