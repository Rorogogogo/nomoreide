import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { TerminalSpawnOptions } from "./terminal-manager.js";

const SAFE_SSH_DESTINATION = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

export interface SshSetupStatus {
  publicKeys: string[];
  sshCopyIdAvailable: boolean;
}

export type SshSetupAction = "generate-key" | "install-key";

export async function inspectSshSetup(options: {
  sshDirectory?: string;
  pathValue?: string;
} = {}): Promise<SshSetupStatus> {
  const sshDirectory = options.sshDirectory ?? join(homedir(), ".ssh");
  const publicKeys = (await readdir(sshDirectory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".pub"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return {
    publicKeys,
    sshCopyIdAvailable: await executableExists(
      "ssh-copy-id",
      options.pathValue ?? process.env.PATH ?? "",
    ),
  };
}

export function resolveSshSetupTerminal(
  action: SshSetupAction,
  destination?: string,
): TerminalSpawnOptions {
  if (action === "generate-key") {
    return {
      shell: "ssh-keygen",
      args: ["-t", "ed25519"],
      kind: "shell",
      label: "Generate SSH key",
    };
  }

  const target = destination?.trim() ?? "";
  if (!SAFE_SSH_DESTINATION.test(target)) {
    throw new Error("SSH destination must be a host name, IP, user@host, or SSH config alias.");
  }
  return {
    shell: "ssh-copy-id",
    args: [target],
    kind: "shell",
    label: `Set up SSH · ${target}`,
  };
}

async function executableExists(name: string, pathValue: string): Promise<boolean> {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}
