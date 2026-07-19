// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test, vi } from "vitest";
import {
  activeIncidentFilterCount,
  filterIncidents,
  incidentFilterOptions,
  incidentMatchesQuery,
  type IncidentFilters,
} from "../src/web/client/src/features/errors/incident-filters";
import type { ErrorIncident } from "../src/web/client/src/lib/api";
import { IncidentTable } from "../src/web/client/src/features/errors/incident-table";
import { ErrorInboxView } from "../src/web/client/src/features/errors/error-inbox-view";

const incidentFeed = vi.hoisted(() => ({
  value: {
    incidents: [] as ErrorIncident[],
    connected: false,
    error: null as string | null,
  },
}));

vi.mock("@/components/ui/toast", () => ({
  useToasts: () => ({ error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/features/agent/chat/agent-context", () => ({
  useAgentDock: () => ({ sendToAgent: vi.fn() }),
}));

vi.mock("@/features/errors/use-error-incidents", () => ({
  useErrorIncidents: () => incidentFeed.value,
}));

function incident(overrides: Partial<ErrorIncident> & Pick<ErrorIncident, "id">): ErrorIncident {
  return {
    id: overrides.id,
    service: "api",
    level: "error",
    signature: `signature-${overrides.id}`,
    title: "Database connection failed",
    file: "/workspace/src/database.ts",
    line: 42,
    firstSeen: "2026-07-20T00:00:00.000Z",
    lastSeen: "2026-07-20T00:05:00.000Z",
    count: 3,
    logExcerpt: ["Error: ECONNREFUSED", "at connect (/workspace/src/database.ts:42:1)"],
    ...overrides,
  };
}

const incidents = [
  incident({ id: 3, service: "web", title: "Checkout render warning", level: "warning", file: "/app/checkout.tsx", logExcerpt: ["Hydration mismatch"] }),
  incident({ id: 2, service: "worker", title: "Queue stalled", file: "/app/jobs.ts", logExcerpt: ["Redis timeout"] }),
  incident({ id: 1 }),
];

const noFilters: IncidentFilters = { levels: [], services: [] };

describe("Error Inbox incident filtering", () => {
  test("searches service, title, file, and excerpts case-insensitively", () => {
    expect(filterIncidents(incidents, "WEB", noFilters).map(({ id }) => id)).toEqual([3]);
    expect(filterIncidents(incidents, "queue STALLED", noFilters).map(({ id }) => id)).toEqual([2]);
    expect(filterIncidents(incidents, "CHECKOUT.TSX", noFilters).map(({ id }) => id)).toEqual([3]);
    expect(filterIncidents(incidents, "redis TIMEOUT", noFilters).map(({ id }) => id)).toEqual([2]);
    expect(incidentMatchesQuery(incidents[0], "  hydration mismatch  ")).toBe(true);
  });

  test("intersects filter categories and unions values within a category", () => {
    expect(
      filterIncidents(incidents, "", {
        levels: ["error", "warning"],
        services: ["api", "web"],
      }).map(({ id }) => id),
    ).toEqual([3, 1]);
    expect(
      filterIncidents(incidents, "", {
        levels: ["error"],
        services: ["worker"],
      }).map(({ id }) => id),
    ).toEqual([2]);
  });

  test("preserves the incoming newest-first order", () => {
    expect(filterIncidents(incidents, "", noFilters).map(({ id }) => id)).toEqual([3, 2, 1]);
    expect(filterIncidents(incidents, "", { levels: ["error"], services: [] }).map(({ id }) => id)).toEqual([2, 1]);
  });

  test("counts selected filter values and returns unique sorted options", () => {
    const filters: IncidentFilters = {
      levels: ["warning", "error"],
      services: ["worker", "api"],
    };

    expect(activeIncidentFilterCount(filters)).toBe(4);
    expect(activeIncidentFilterCount(noFilters)).toBe(0);
    expect(incidentFilterOptions(incidents)).toEqual({
      levels: ["error", "warning"],
      services: ["api", "web", "worker"],
    });
  });
});

async function renderTable(
  props: Partial<ComponentProps<typeof IncidentTable>> = {},
) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (next: Partial<ComponentProps<typeof IncidentTable>> = {}) => {
    await act(async () => {
      root.render(
        <IncidentTable
          connected
          error={null}
          incidents={incidents}
          {...props}
          {...next}
        />,
      );
    });
  };
  await render();
  return {
    host,
    render,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    },
  };
}

function inputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("IncidentTable", () => {
  test("shows a compact count, connection state, and searchable rows", async () => {
    const mounted = await renderTable();

    expect(mounted.host.textContent).toContain("3 incidents");
    expect(mounted.host.textContent).toContain("live");
    expect(mounted.host.querySelectorAll('[data-incident-id]')).toHaveLength(3);

    const search = mounted.host.querySelector<HTMLInputElement>(
      'input[aria-label="Search incidents"]',
    );
    expect(search).not.toBeNull();
    inputValue(search!, "redis timeout");
    expect(mounted.host.querySelectorAll('[data-incident-id]')).toHaveLength(1);
    expect(mounted.host.textContent).toContain("Queue stalled");

    await mounted.render({ connected: false });
    expect(mounted.host.textContent).toContain("reconnecting");
    await mounted.unmount();
  });

  test("filters with pressed controls, reports active count, and clears", async () => {
    const mounted = await renderTable();
    const filterToggle = mounted.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Show filters"]',
    );
    act(() => filterToggle?.click());

    const warning = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Warning");
    const web = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "web");
    expect(warning?.getAttribute("aria-pressed")).toBe("false");
    act(() => warning?.click());
    act(() => web?.click());

    expect(warning?.getAttribute("aria-pressed")).toBe("true");
    expect(mounted.host.querySelectorAll('[data-incident-id]')).toHaveLength(1);
    expect(filterToggle?.textContent).toContain("2");

    const clear = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Clear filters"));
    act(() => clear?.click());
    expect(mounted.host.querySelectorAll('[data-incident-id]')).toHaveLength(3);
    expect(filterToggle?.textContent).not.toContain("2");
    await mounted.unmount();
  });

  test("expands one inline detail region at a time", async () => {
    const mounted = await renderTable();
    const first = mounted.host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Expand incident"]',
    );
    act(() => first?.click());

    expect(first?.getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.querySelectorAll('[data-incident-detail="true"]')).toHaveLength(1);
    expect(mounted.host.textContent).toContain("Hydration mismatch");
    expect(mounted.host.textContent).toContain("/app/checkout.tsx");
    expect(mounted.host.textContent).toContain("first");
    expect(mounted.host.textContent).toContain("Fix with AI");

    const second = mounted.host.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Expand incident"]',
    )[1];
    act(() => second.click());
    expect(first?.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.querySelectorAll('[data-incident-detail="true"]')).toHaveLength(1);
    await mounted.unmount();
  });

  test("distinguishes an empty inbox from no filter matches", async () => {
    const empty = await renderTable({ incidents: [] });
    expect(empty.host.textContent).toContain("No incidents yet");
    await empty.unmount();

    const filtered = await renderTable();
    const search = filtered.host.querySelector<HTMLInputElement>(
      'input[aria-label="Search incidents"]',
    );
    inputValue(search!, "definitely absent");
    expect(filtered.host.textContent).toContain("No incidents match");
    expect(filtered.host.textContent).toContain("Clear filters");
    await filtered.unmount();
  });

  test("preserves filters and expansion when live incident data updates", async () => {
    const mounted = await renderTable();
    inputValue(
      mounted.host.querySelector<HTMLInputElement>('input[aria-label="Search incidents"]')!,
      "web",
    );
    const expand = mounted.host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Expand incident"]',
    );
    act(() => expand?.click());

    await mounted.render({
      incidents: [
        { ...incidents[0], title: "Updated checkout warning", count: 9 },
        ...incidents.slice(1),
      ],
    });

    expect(
      mounted.host.querySelector<HTMLInputElement>('input[aria-label="Search incidents"]')?.value,
    ).toBe("web");
    expect(mounted.host.textContent).toContain("Updated checkout warning");
    expect(mounted.host.textContent).toContain("×9");
    expect(mounted.host.querySelector('[aria-expanded="true"]')).not.toBeNull();
    await mounted.unmount();
  });

  test("avoids the demo shell and simulated log model", () => {
    const source = readFileSync(
      resolve("src/web/client/src/features/errors/incident-table.tsx"),
      "utf8",
    );

    expect(source).not.toContain("h-screen");
    expect(source).not.toContain("SAMPLE_LOGS");
    expect(source).not.toContain("duration_ms");
    expect(source).toContain("useReducedMotion");
  });
});

describe("ErrorInboxView", () => {
  test("scopes live incidents and forwards connection, error, and review props to the table", async () => {
    incidentFeed.value = {
      incidents,
      connected: false,
      error: "initial fetch failed",
    };
    const onReviewChanges = vi.fn();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <ErrorInboxView
          inScope={(service) => service === "web"}
          onReviewChanges={onReviewChanges}
        />,
      );
    });

    expect(host.querySelectorAll("[data-incident-id]")).toHaveLength(1);
    expect(host.textContent).toContain("Checkout render warning");
    expect(host.textContent).not.toContain("Queue stalled");
    expect(host.textContent).toContain("reconnecting");
    expect(host.textContent).toContain("initial fetch failed");
    expect(host.querySelector('input[aria-label="Search incidents"]')).not.toBeNull();

    const source = readFileSync(
      resolve("src/web/client/src/features/errors/error-inbox-view.tsx"),
      "utf8",
    );
    expect(source).toContain("<IncidentTable");
    expect(source).toContain("onReviewChanges={onReviewChanges}");
    expect(source).not.toContain("w-72");

    await act(async () => root.unmount());
    host.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });
});
