import { apiFetch } from "./desktop-runtime.js";

export type ApiEventSource = Pick<
  EventSource,
  "addEventListener" | "removeEventListener" | "close"
>;

/** First reconnect delay, and the ceiling it backs off to. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

class AuthenticatedEventSource extends EventTarget {
  private readonly controller = new AbortController();
  private retryMs = RETRY_MIN_MS;
  /** Set by a `retry:` field, which pins the delay rather than backing off. */
  private serverRetryMs: number | null = null;

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
        // A 200 that is not a stream is not a stream. Without this check a JSON
        // body reads as zero frames and ends immediately, which looks like a
        // clean disconnect and reconnects at once — a busy loop against
        // whatever answered.
        const kind = response.headers.get("content-type") ?? "";
        if (!kind.includes("text/event-stream")) {
          throw new Error(`Event stream returned ${kind || "no content type"}.`);
        }
        // Connected, so the next failure starts its backoff from the floor
        // rather than from wherever the last outage climbed to.
        this.retryMs = RETRY_MIN_MS;
        this.dispatchEvent(new Event("open"));
        await this.read(response.body);
      } catch (caught) {
        if (this.controller.signal.aborted) return;
        this.dispatchEvent(new Event("error"));
        void caught;
      }
      await waitForRetry(this.serverRetryMs ?? this.retryMs, this.controller.signal);
      // Back off, so a stream that is refused — a daemon that stopped, a route
      // that 401s — is retried at a widening interval rather than once a second
      // forever. `EventSource` does this for us; doing it ourselves is part of
      // the cost of replacing it.
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
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
      else if (field === "retry" && /^\d+$/.test(value)) this.serverRetryMs = Number(value);
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

/**
 * A server-sent-event stream that can authenticate.
 *
 * **Always the fetch-backed one, never the native `EventSource`.** This used to
 * hand a browser `new EventSource(url)` and keep the authenticated path for the
 * desktop app — but every `/api/*` route is behind `require_credential`, and an
 * `EventSource` cannot set an `Authorization` header. So in a browser the
 * terminal, the error inbox and the agent tool-call feed all answered
 * `401 Unauthorized` and silently never updated, while the console filled with
 * reconnects.
 *
 * The credential is available in both places — `__NOMOREIDE_DESKTOP__` in the
 * app, `__NOMOREIDE_WEB__` injected into the document by the daemon's shell —
 * and `apiFetch` reads whichever is there. There was never a reason for the
 * browser to take a different path.
 */
export function openApiEventSource(url: string): ApiEventSource {
  return new AuthenticatedEventSource(url) as ApiEventSource;
}
