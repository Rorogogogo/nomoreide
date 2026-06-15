/** Rust-core implementation of {@link OnboardApi}, over Tauri `invoke()` (desktop). */
import {
  tauriListen,
  tauri_scanRepoUrl,
  tauri_runInstallCommand,
  tauri_registerService,
  tauri_registerGitRepository,
  tauri_registerDatabase,
  tauri_startService,
} from "./tauri-bridge.js";
import type { OnboardApi, OnboardScanResult } from "./onboard-api.js";

export const tauriOnboardApi: OnboardApi = {
  scanRepo: (url) => tauri_scanRepoUrl(url) as Promise<OnboardScanResult>,

  async registerOnboarded(proposal, start, database) {
    await tauri_registerGitRepository({ name: proposal.name, path: proposal.cwd });
    await tauri_registerService({
      name: proposal.name,
      kind: proposal.kind,
      command: proposal.command ?? null,
      cwd: proposal.cwd,
      port: proposal.port ?? null,
      composeFile: proposal.composeFile ?? null,
      composeService: proposal.composeService ?? null,
    });
    if (database) {
      await tauri_registerDatabase({
        name: database.name,
        engine: database.engine,
        url: database.url,
      });
    }
    if (start) await tauri_startService(proposal.name);
  },

  async streamInstall(params, handlers) {
    let unlisten: (() => void) | undefined;
    unlisten = await tauriListen("install-output", (payload) => {
      const evt = payload as {
        type: string;
        stream?: "stdout" | "stderr";
        text?: string;
        exitCode?: number | null;
        message?: string;
      };
      if (evt.type === "line") {
        handlers.onLine({ stream: evt.stream ?? "stdout", text: evt.text ?? "" });
      } else if (evt.type === "done") {
        unlisten?.();
        handlers.onDone(evt.exitCode ?? null);
      } else if (evt.type === "error") {
        unlisten?.();
        handlers.onError(evt.message ?? "Install failed");
      }
    });
    try {
      await tauri_runInstallCommand(params.clonePath, params.command);
    } catch (e) {
      unlisten?.();
      handlers.onError(String(e));
    }
  },
};
