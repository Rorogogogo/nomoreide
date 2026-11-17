/**
 * Open a URL outside the dashboard: a new browser tab, or — in the
 * `nomoreide menubar` window — the default browser, because the menu bar app
 * sends every new-window request there.
 */
export async function openExternal(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}
