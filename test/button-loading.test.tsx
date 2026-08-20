import { readFileSync } from "node:fs";
import { Save } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Button } from "../apps/dashboard/src/components/ui/button";

describe("Button loading state", () => {
  test("renders an accessible pending label without leaking custom props", () => {
    const html = renderToStaticMarkup(
      <Button loading loadingLabel="Saving…">
        Save
      </Button>,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Saving…");
    expect(html).not.toContain(">Save<");
    expect(html).toContain("animate-spin");
    expect(html).toContain("disabled");
    expect(html).not.toContain('loading=""');
    expect(html).not.toContain("loadingLabel");
  });

  test("preserves a caller-supplied disabled state", () => {
    const html = renderToStaticMarkup(<Button disabled>Save</Button>);

    expect(html).toContain("disabled");
    expect(html).not.toContain("aria-busy");
  });

  test("replaces icon-only contents with only the spinner", () => {
    const html = renderToStaticMarkup(
      <Button aria-label="Save" loading size="icon">
        <Save data-testid="save-icon" />
      </Button>,
    );

    expect(html).toContain("animate-spin");
    expect(html).not.toContain("save-icon");
  });

  test("renders ordinary children unchanged when not loading", () => {
    const html = renderToStaticMarkup(<Button>Save changes</Button>);

    expect(html).toContain(">Save changes<");
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("aria-busy");
  });

  test("keeps toast actions on the canonical button primitive", () => {
    const toast = readFileSync(
      "apps/dashboard/src/components/ui/toast.tsx",
      "utf8",
    );
    const demo = readFileSync(
      "apps/dashboard/src/components/ui/toast-demo.tsx",
      "utf8",
    );
    const productionSources = `${toast}\n${demo}`;

    expect(productionSources).toContain('from "@/components/ui/button"');
    expect(productionSources).not.toContain("button-1");
    expect(productionSources).not.toContain("spinner-1");
  });
});
