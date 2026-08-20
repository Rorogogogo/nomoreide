import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const appSource = readFileSync(
  resolve(__dirname, "../apps/dashboard/src/app.tsx"),
  "utf8",
);

describe("responsive workbench shell", () => {
  test("fills wide viewports instead of exposing centered side gutters", () => {
    expect(appSource).toContain(
      'className="flex h-full w-full min-w-0" data-workbench-shell',
    );
    expect(appSource).not.toContain("max-w-[1500px]");
  });
});
