// Tauri environment detection and native window controls.
// All functions are no-ops when running in a regular browser.

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

// Tauri v2 only injects `window.__TAURI__` when `withGlobalTauri` is enabled,
// which we keep off. The internals object (`window.__TAURI_INTERNALS__`) is
// always present inside a Tauri webview, so detect on that and fall back to the
// global for safety. Without this, every api call wrongly takes the HTTP branch
// (there's no Node server in the desktop app) and the whole UI renders empty.
export const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  (Boolean(window.__TAURI_INTERNALS__) || Boolean(window.__TAURI__));

type TauriWindowModule = {
  getCurrentWindow: () => {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    hide: () => Promise<void>;
    startDragging: () => Promise<void>;
  };
};

async function windowModule(): Promise<TauriWindowModule | null> {
  if (!isTauri()) return null;
  try {
    return (await import("@tauri-apps/api/window")) as TauriWindowModule;
  } catch {
    return null;
  }
}

export async function minimizeWindow(): Promise<void> {
  const m = await windowModule();
  await m?.getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  const m = await windowModule();
  await m?.getCurrentWindow().toggleMaximize();
}

export async function hideWindow(): Promise<void> {
  const m = await windowModule();
  await m?.getCurrentWindow().hide();
}

export async function startDragging(): Promise<void> {
  const m = await windowModule();
  await m?.getCurrentWindow().startDragging();
}

/**
 * Open a URL in the system default browser. In a Tauri webview `window.open`
 * is swallowed (it tries to navigate the webview or no-ops), so route external
 * links through the Rust `open_external` command instead; the web build keeps
 * using `window.open`.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_external", { url });
      return;
    } catch {
      // Fall through to window.open if the command is unavailable.
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
