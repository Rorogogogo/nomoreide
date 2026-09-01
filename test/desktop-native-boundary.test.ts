import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");

describe("desktop native boundary", () => {
  test("keeps product data on HTTP and only OS integration in Tauri commands", () => {
    const apiFiles = readdirSync(resolve(root, "apps/dashboard/src/lib/api"));
    expect(apiFiles.filter((file) => file.endsWith("-tauri.ts"))).toEqual([]);
    expect(apiFiles).not.toContain("tauri-bridge.ts");

    const commandFiles = readdirSync(
      resolve(root, "crates/nomoreide-tauri/src/commands"),
    ).sort();
    expect(commandFiles).toEqual(["mod.rs", "system.rs"]);

    const shell = readFileSync(
      resolve(root, "crates/nomoreide-tauri/src/lib.rs"),
      "utf8",
    );
    expect(shell).toContain(
      "tauri::generate_handler![commands::system::open_external]",
    );

    const nativeClient = readFileSync(
      resolve(root, "apps/dashboard/src/lib/tauri.ts"),
      "utf8",
    );
    expect(nativeClient).toContain("window.__TAURI_INTERNALS__");
    expect(nativeClient).toContain("minimizeWindow");
    expect(nativeClient).toContain("toggleMaximizeWindow");
    expect(nativeClient).toContain("startDragging");
    expect(nativeClient).toContain('invoke("open_external"');
  });
});
