// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TabStrip } from "../src/web/client/src/components/ui/tab-strip";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.replaceChildren();
});

describe("TabStrip keyboard navigation", () => {
  test("uses roving focus and selects tabs with arrow keys", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    function Example() {
      const [value, setValue] = useState<"local" | "registry">("local");
      return (
        <TabStrip
          ariaLabel="Profile source"
          idPrefix="profiles"
          onSelect={setValue}
          tabs={[
            { id: "local", label: "Local" },
            { id: "registry", label: "Registry" },
          ]}
          value={value}
        />
      );
    }

    await act(async () => {
      root.render(<Example />);
    });
    const [local, registry] = Array.from(host.querySelectorAll("button"));
    expect(local.tabIndex).toBe(0);
    expect(registry.tabIndex).toBe(-1);

    await act(async () => {
      local.focus();
      local.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(registry.getAttribute("aria-selected")).toBe("true");
    expect(registry.tabIndex).toBe(0);
    expect(document.activeElement).toBe(registry);
  });
});
