import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { TerminalPane } from "../src/web/client/src/features/terminal/terminal-pane";
import {
  TerminalViewport,
  type TerminalViewportHandle,
  type TerminalViewportStatus,
} from "../src/web/client/src/features/terminal/terminal-viewport";
import { TerminalView } from "../src/web/client/src/features/terminal/terminal-view";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    focus() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));

describe("TerminalView", () => {
  test("renders the tab strip with a new-terminal control", () => {
    const markup = renderToStaticMarkup(<TerminalView />);

    expect(markup).toContain("Terminal tabs");
    expect(markup).toContain("New terminal");
    // Effects don't run under SSR, so the page shows its pre-fetch placeholder.
    expect(markup).toContain("Starting terminal");
  });
});

describe("TerminalPane", () => {
  test("renders the per-tab controls and viewport", () => {
    const markup = renderToStaticMarkup(
      <TerminalPane active sessionId="term_1" />,
    );

    expect(markup).toContain("Restart");
    expect(markup).toContain("Stop");
    expect(markup).toContain("terminal viewport");
  });

  test("hides an inactive pane but keeps it mounted", () => {
    const markup = renderToStaticMarkup(
      <TerminalPane active={false} sessionId="term_2" />,
    );

    expect(markup).toContain("hidden");
    expect(markup).toContain("terminal viewport");
  });
});

describe("TerminalViewport", () => {
  test("renders only the raw terminal viewport", () => {
    const markup = renderToStaticMarkup(
      <TerminalViewport active sessionId="term_raw" />,
    );

    expect(markup).toContain("terminal viewport");
    expect(markup).not.toContain("Restart");
    expect(markup).not.toContain("Stop");
  });

  test("stays rendered while inactive and exposes its control contracts", () => {
    const handle = createRef<TerminalViewportHandle>();
    const statuses: TerminalViewportStatus[] = [];
    const markup = renderToStaticMarkup(
      <TerminalViewport
        active={false}
        onStatusChange={(status) => statuses.push(status)}
        ref={handle}
        sessionId="term_hidden"
      />,
    );

    expect(markup).toContain("hidden");
    expect(markup).toContain("terminal viewport");
    expect(handle).toHaveProperty("current");
    expect(statuses).toEqual([]);
  });
});
