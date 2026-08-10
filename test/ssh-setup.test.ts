import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  inspectSshSetup,
  resolveSshSetupTerminal,
} from "../src/core/ssh-setup.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("SSH setup", () => {
  test("reports public keys and ssh-copy-id availability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nomoreide-ssh-setup-"));
    tempDirs.push(directory);
    const sshDirectory = join(directory, ".ssh");
    const binDirectory = join(directory, "bin");
    await Promise.all([mkdir(sshDirectory), mkdir(binDirectory)]);
    await Promise.all([
      writeFile(join(sshDirectory, "id_ed25519.pub"), "ssh-ed25519 test"),
      writeFile(join(sshDirectory, "config"), "Host prod"),
      writeFile(join(binDirectory, "ssh-copy-id"), "#!/bin/sh\n"),
    ]);
    await chmod(join(binDirectory, "ssh-copy-id"), 0o755);

    await expect(inspectSshSetup({ sshDirectory, pathValue: binDirectory })).resolves.toEqual({
      publicKeys: ["id_ed25519.pub"],
      sshCopyIdAvailable: true,
    });
  });

  test("builds terminal invocations without shell interpolation", () => {
    expect(resolveSshSetupTerminal("generate-key")).toMatchObject({
      shell: "ssh-keygen",
      args: ["-t", "ed25519"],
    });
    expect(resolveSshSetupTerminal("install-key", "deploy@192.168.1.20")).toMatchObject({
      shell: "ssh-copy-id",
      args: ["deploy@192.168.1.20"],
    });
  });

  test("rejects destinations that could become SSH options", () => {
    expect(() => resolveSshSetupTerminal("install-key", "-oProxyCommand=bad"))
      .toThrow(/SSH destination/);
    expect(() => resolveSshSetupTerminal("install-key", "user@host;touch-bad"))
      .toThrow(/SSH destination/);
  });
});
