import { describe, expect, test } from "vitest";
import { previewArgs, redactSensitiveText } from "../src/core/tool-call-store.js";

describe("tool-call credential redaction", () => {
  test("redacts credential-bearing database registration arguments", () => {
    const preview = previewArgs({
      name: "app",
      engine: "postgres",
      url: "postgres://user:secret@localhost/app",
      check: true,
    });
    expect(preview).not.toContain("secret");
    expect(preview).not.toContain("postgres://");
    expect(preview).toContain("[redacted]");
  });

  test("redacts connection URLs embedded in recorded errors", () => {
    const redacted = redactSensitiveText(
      "failed postgres://user:secret@localhost/app password=secret",
    );
    expect(redacted).toBe("failed postgres://user:****@localhost/app password=****");
  });
});
