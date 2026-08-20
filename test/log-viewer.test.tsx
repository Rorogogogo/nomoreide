import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LogViewer } from "../apps/dashboard/src/features/services/log-viewer";
import type { LogEntry } from "../apps/dashboard/src/lib/api";

describe("LogViewer", () => {
  test("renders dark-mode console classes for stdout and stderr rows", () => {
    const logs: LogEntry[] = [
      {
        service: "web",
        stream: "stdout",
        text: "VITE ready",
        timestamp: "2026-05-30T04:11:52.720Z",
      },
      {
        service: "web",
        stream: "stderr",
        text: "Error: failed",
        timestamp: "2026-05-30T04:11:53.720Z",
      },
    ];

    const markup = renderToStaticMarkup(
      <LogViewer
        containerRef={createRef<HTMLDivElement>()}
        emptyText="No log entries."
        logs={logs}
        query="failed"
      />,
    );

    expect(markup).toContain("dark:bg-zinc-950");
    expect(markup).toContain("dark:text-zinc-200");
    expect(markup).toContain("dark:bg-red-950/35");
    expect(markup).toContain("dark:text-red-100");
    expect(markup).toContain("dark:bg-amber-400/20");
    expect(markup).toContain("dark:text-amber-200");
  });
});
