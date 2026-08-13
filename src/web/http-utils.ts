import type { IncomingMessage, ServerResponse } from "node:http";

export function sendHtml(
  response: ServerResponse,
  html: string,
  status = 200,
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}

export function sendText(
  response: ServerResponse,
  text: string,
  status = 200,
): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(text);
}

export function sendHead(
  response: ServerResponse,
  contentType: string,
  status = 200,
): void {
  response.writeHead(status, {
    "content-type": contentType,
  });
  response.end();
}

export function sendJson(
  response: ServerResponse,
  data: unknown,
  status = 200,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}

export async function readForm(
  request: IncomingMessage,
): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** Read a JSON request body, returning `{}` for an empty or invalid payload. */
export async function readJson(
  request: IncomingMessage,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
  }
}

export function requiredFormValue(
  form: URLSearchParams,
  key: string,
): string {
  const value = form.get(key)?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function optionalFormValue(
  form: URLSearchParams,
  key: string,
): string | undefined {
  const value = form.get(key)?.trim();
  return value || undefined;
}
