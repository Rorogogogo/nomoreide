// Tauri environment detection and native window controls.
// All functions are no-ops when running in a regular browser.

declare global {
  interface Window {
    __TAURI__?: unknown;
  }
}

export const isTauri = (): boolean => typeof window !== "undefined" && Boolean(window.__TAURI__);

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
