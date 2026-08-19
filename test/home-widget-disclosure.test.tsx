// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useWidgetDisclosure } from "../src/web/client/src/features/home/use-widget-disclosure";
import {
  WidgetMore,
  WidgetPanel,
  WidgetStat,
  WidgetStats,
} from "../src/web/client/src/features/home/widget-grid";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Home widget disclosure", () => {
  test("docks counters into the title row when the panel is wide enough", async () => {
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 500,
    });

    await act(async () =>
      root.render(
        <WidgetPanel
          height={null}
          icon={null}
          id="services"
          lessLabel="Show less"
          onDisclosureToggle={() => {}}
          onOpen={() => {}}
          openLabel="Open Services"
          place={undefined}
          title="Services"
        >
          <WidgetStats>
            <WidgetStat label="Running" tone="ok" value={2} />
          </WidgetStats>
        </WidgetPanel>,
      ),
    );

    const header = host.querySelector('[data-widget-body="services"]')?.firstElementChild;
    expect(header?.querySelector('[title="Running"]')).not.toBeNull();

    if (clientWidth) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });

  test("toggles one expanded widget", async () => {
    function Example() {
      const { expanded, toggleExpanded } = useWidgetDisclosure();
      return (
        <>
          <output>{expanded ?? "grid"}</output>
          <button onClick={() => toggleExpanded("logs", false)} type="button">
            Toggle logs
          </button>
        </>
      );
    }

    await act(async () => root.render(<Example />));
    const button = host.querySelector("button");

    await act(async () => button?.click());
    expect(host.querySelector("output")?.textContent).toBe("logs");

    await act(async () => button?.click());
    expect(host.querySelector("output")?.textContent).toBe("grid");
  });

  test("uses the contextual more and less controls instead of a header action", async () => {
    function Example() {
      const [expanded, setExpanded] = useState(false);
      return (
        <WidgetPanel
          expanded={expanded}
          height={expanded ? 8 : null}
          icon={null}
          id="logs"
          lessLabel="Show less"
          onDisclosureToggle={() => setExpanded((value) => !value)}
          onOpen={() => {}}
          openLabel="Open Logs"
          place={undefined}
          title="Logs"
        >
          {expanded ? <span>All rows</span> : <WidgetMore>+3 more</WidgetMore>}
        </WidgetPanel>
      );
    }

    await act(async () => root.render(<Example />));
    expect(host.querySelector('[aria-label="Expand Logs"]')).toBeNull();

    const more = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "+3 more",
    );
    more?.focus();
    await act(async () => more?.click());
    expect(host.textContent).toContain("All rows");

    const less = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Show less",
    );
    expect(document.activeElement).toBe(less);
    await act(async () => less?.click());
    expect(host.textContent).toContain("+3 more");
    expect(document.activeElement?.textContent).toBe("+3 more");
  });
});
