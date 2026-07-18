import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AppSettingsStore,
  DEFAULT_APP_SETTINGS,
} from "../src/core/app-settings.js";

let tempDir: string;
let settingsPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-app-settings-"));
  settingsPath = join(tempDir, "nested", "settings.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("AppSettingsStore", () => {
  test("returns independent defaults when the settings file is missing", async () => {
    const store = new AppSettingsStore(settingsPath);

    const settings = await store.load();
    settings.terminal.fontSize = 20;

    expect(await store.load()).toEqual(DEFAULT_APP_SETTINGS);
    expect(DEFAULT_APP_SETTINGS.terminal.fontSize).toBe(13);
  });

  test("deep-merges a validated patch and persists version 1", async () => {
    const store = new AppSettingsStore(settingsPath);

    const updated = await store.update({
      terminal: { fontSize: 16, cursorStyle: "bar" },
    });

    expect(updated).toEqual({
      ...DEFAULT_APP_SETTINGS,
      terminal: {
        ...DEFAULT_APP_SETTINGS.terminal,
        fontSize: 16,
        cursorStyle: "bar",
      },
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(updated);
    expect(updated.version).toBe(1);
  });

  test("rejects an invalid terminal font size without changing the last valid file", async () => {
    const store = new AppSettingsStore(settingsPath);
    await store.update({ terminal: { scrollback: 8_000 } });
    const lastValidFile = await readFile(settingsPath, "utf8");

    await expect(
      store.update({ terminal: { fontSize: 25 } }),
    ).rejects.toThrow();

    expect(await readFile(settingsPath, "utf8")).toBe(lastValidFile);
    expect((await store.load()).terminal.scrollback).toBe(8_000);
  });

  test("reset persists and returns independent defaults", async () => {
    const store = new AppSettingsStore(settingsPath);
    await store.update({
      terminal: { copyOnSelect: true, confirmTerminate: false },
    });

    const reset = await store.reset();

    expect(reset).toEqual(DEFAULT_APP_SETTINGS);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(
      DEFAULT_APP_SETTINGS,
    );
    reset.terminal.cursorStyle = "underline";
    expect((await store.load()).terminal.cursorStyle).toBe("block");
  });
});
