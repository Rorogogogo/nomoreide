import { apiFetch } from "./desktop-runtime.js";

export type ApiEventSource = Pick<
  EventSource,
  "addEventListener" | "removeEventListener" | "close"
>;

class AuthenticatedEventSource extends EventTarget {
  private readonly controller = new AbortController();
  private retryMs = 1_000;

  constructor(private readonly url: string) {
    super();
    void this.connect();
  }

  close(): void {
    this.controller.abort();
  }

  private async connect(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        const response = await apiFetch(this.url, {
          headers: { accept: "text/event-stream" },
          signal: this.controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Event stream failed (${response.status}).`);
        }
        this.dispatchEvent(new Event("open"));
        await this.read(response.body);
      } catch (caught) {
        if (this.controller.signal.aborted) return;
        this.dispatchEvent(new Event("error"));
        void caught;
      }
      await waitForRetry(this.retryMs, this.controller.signal);
    }
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!this.controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = frameBoundary(buffer);
        while (boundary) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          this.dispatchFrame(frame);
          boundary = frameBoundary(buffer);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private dispatchFrame(frame: string): void {
    let event = "message";
    let lastEventId = "";
    const data: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith(":")) continue;
      const separator = rawLine.indexOf(":");
      const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
      let value = separator === -1 ? "" : rawLine.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event" && value) event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") lastEventId = value;
      else if (field === "retry" && /^\d+$/.test(value)) this.retryMs = Number(value);
    }
    if (!data.length) return;
    this.dispatchEvent(
      new MessageEvent(event, {
        data: data.join("\n"),
        lastEventId,
      }),
    );
  }
}

function frameBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, delay);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export function openApiEventSource(url: string): ApiEventSource {
  if (typeof window === "undefined" || !window.__NOMOREIDE_DESKTOP__) {
    return new EventSource(url);
  }
  return new AuthenticatedEventSource(url) as ApiEventSource;
}
