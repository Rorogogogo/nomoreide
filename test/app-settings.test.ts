import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("loads a settings file written before smoothScroll existed", async () => {
    // `load()` only forgives ENOENT, so a newly-added required field would make
    // every pre-existing settings.json throw instead of picking up the default.
    await mkdir(join(tempDir, "nested"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        terminal: {
          fontSize: 15,
          cursorStyle: "bar",
          scrollback: 2_000,
          copyOnSelect: true,
          confirmTerminate: false,
        },
      }),
    );

    const settings = await new AppSettingsStore(settingsPath).load();

    expect(settings.terminal.smoothScroll).toBe(true);
    expect(settings.terminal.fontSize).toBe(15);
    expect(settings.terminal.confirmTerminate).toBe(false);
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

  test("serializes concurrent partial updates on the same store", async () => {
    const store = new AppSettingsStore(settingsPath);

    await Promise.all([
      store.update({ terminal: { fontSize: 16 } }),
      store.update({ terminal: { copyOnSelect: true } }),
    ]);

    expect(await store.load()).toEqual({
      ...DEFAULT_APP_SETTINGS,
      terminal: {
        ...DEFAULT_APP_SETTINGS.terminal,
        fontSize: 16,
        copyOnSelect: true,
      },
    });
  });

  test("continues queued writes after a rejected update", async () => {
    const store = new AppSettingsStore(settingsPath);

    const [invalid, valid] = await Promise.allSettled([
      store.update({ terminal: { fontSize: 25 } }),
      store.update({ terminal: { cursorStyle: "underline" } }),
    ]);

    expect(invalid.status).toBe("rejected");
    expect(valid.status).toBe("fulfilled");
    expect((await store.load()).terminal.cursorStyle).toBe("underline");
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
