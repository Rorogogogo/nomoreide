import { expect, test } from "vitest";
import * as catalogue from "../apps/dashboard/src/features/settings/settings-catalogue";

test("fails fast when rendered setting copy is missing", () => {
  expect(() =>
    (catalogue as typeof catalogue & {
      settingCopy(id: string): { label: string; description: string };
    }).settingCopy("missing-setting"),
  ).toThrow("Missing settings copy");
});
