import { describe, expect, test } from "vitest";
import {
  parseRemoteDirectoryListing,
  parseRemoteFileContent,
} from "../src/core/ssh-servers.js";
import { parentRemotePath } from "../src/web/client/src/features/servers/remote-file-explorer.js";

describe("SSH remote file parsing", () => {
  test("walks from the SSH home directory to the filesystem root", () => {
    expect(parentRemotePath("/home/deploy")).toBe("/home");
    expect(parentRemotePath("/home")).toBe("/");
    expect(parentRemotePath("/")).toBeNull();
  });

  test("parses NUL-delimited entries, hides dotfiles, and sorts directories first", () => {
    const output = nullDelimited([
      "NMI_PATH",
      "/home/deploy",
      "NMI_ENTRY",
      "index.ts",
      "f",
      "42",
      "100.5",
      "",
      "NMI_ENTRY",
      ".env",
      "f",
      "12",
      "101",
      "",
      "NMI_ENTRY",
      "src",
      "d",
      "4096",
      "99",
      "",
    ]);

    expect(parseRemoteDirectoryListing("prod", output)).toEqual({
      host: "prod",
      path: "/home/deploy",
      entries: [
        {
          name: "src",
          path: "/home/deploy/src",
          type: "directory",
          size: 4096,
          modifiedAt: 99_000,
        },
        {
          name: "index.ts",
          path: "/home/deploy/index.ts",
          type: "file",
          size: 42,
          modifiedAt: 100_500,
        },
      ],
    });
  });

  test("includes dotfiles only when explicitly requested and keeps unusual names intact", () => {
    const output = nullDelimited([
      "NMI_PATH",
      "/",
      "NMI_ENTRY",
      ".env production",
      "f",
      "5",
      "1",
      "",
    ]);

    expect(parseRemoteDirectoryListing("prod", output, true).entries[0]).toMatchObject({
      name: ".env production",
      path: "/.env production",
    });
  });

  test("marks binary and oversized previews without returning binary text", () => {
    const binary = Buffer.concat([
      Buffer.from("NMI_FILE\0"),
      Buffer.from("999999\0"),
      Buffer.from([1, 2, 0, 3]),
    ]);

    expect(parseRemoteFileContent("prod", "/tmp/archive.bin", binary)).toMatchObject({
      binary: true,
      content: "",
      size: 999_999,
      truncated: true,
    });
  });

  test("rejects output that does not carry the file protocol marker", () => {
    expect(() => parseRemoteFileContent("prod", "/tmp/a", Buffer.from("oops"))).toThrow(
      "unexpected response",
    );
  });
});

function nullDelimited(fields: string[]): Buffer {
  return Buffer.from(fields.join("\0"));
}
