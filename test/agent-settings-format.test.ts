import { describe, expect, test } from "vitest";
import {
  formatAgentSettingsContent,
  validateAgentSettingsContent,
} from "../apps/dashboard/src/features/agent-env/agent-settings-format";

describe("agent settings editor format and validation", () => {
  test("formats valid JSON and rejects invalid JSON before save", () => {
    expect(formatAgentSettingsContent('{"model":"sonnet","enabled":true}', "json"))
      .toBe('{\n  "model": "sonnet",\n  "enabled": true\n}\n');
    expect(validateAgentSettingsContent('{"model":', "json")).toMatchObject({
      valid: false,
    });
  });

  test("formats and validates TOML documents", () => {
    const formatted = formatAgentSettingsContent('# Keep this\nmodel="gpt-5"\n[tools]\nenabled=true', "toml");
    expect(formatted).toContain("# Keep this");
    expect(formatted).toContain('model = "gpt-5"');
    expect(formatted).toContain("[tools]");
    expect(validateAgentSettingsContent("model = [", "toml")).toMatchObject({
      valid: false,
    });
  });

  test("requires a table/object at the top level", () => {
    expect(validateAgentSettingsContent("[]", "json")).toEqual({
      valid: false,
      error: "top-level value must be an object",
    });
  });
});
