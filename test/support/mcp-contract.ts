import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const REQUEST_TIMEOUT_MS = 15_000;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export async function callMcpTool(
  command: McpCommand,
  name: string,
  args: Record<string, unknown>,
): Promise<Omit<JsonRpcResponse, "id" | "jsonrpc">> {
  const client = new RawMcpClient(command);
  try {
    const initialize = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "nomoreide-tool-parity", version: "1.0.0" },
    });
    if (initialize.error) {
      throw new Error(`MCP initialize failed: ${initialize.error.message}`);
    }
    client.notify("notifications/initialized");
    return contractResponse(
      await client.request("tools/call", { name, arguments: args }),
    );
  } finally {
    await client.close();
  }
}

export interface McpCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface McpContract {
  contractVersion: 1;
  initialize: unknown;
  tools: unknown[];
  cases: Array<{
    name: string;
    request: {
      method: string;
      params?: unknown;
    };
    response: Omit<JsonRpcResponse, "id" | "jsonrpc">;
  }>;
}

export interface McpNormalizationOptions {
  temporaryPaths?: string[];
}

const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const DYNAMIC_NUMBER_KEYS = new Set(["pid", "port"]);
const DYNAMIC_TIME_KEYS = new Set([
  "createdAt",
  "startedAt",
  "timestamp",
  "updatedAt",
]);

class RawMcpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  #nextId = 1;
  #stderr = "";

  constructor(options: McpCommand) {
    this.#child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.#child.on("error", (error) => this.#rejectAll(error));
    this.#child.on("exit", (code, signal) => {
      if (this.#pending.size === 0) return;
      const detail = this.#stderr.trim();
      this.#rejectAll(
        new Error(
          `MCP process exited before replying (code=${code}, signal=${signal})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });

    const lines = createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => {
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.#rejectAll(new Error(`MCP stdout contained a non-protocol line: ${line}`));
        return;
      }
      if (typeof response.id !== "number") return;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(response.id);
      pending.resolve(response);
    });
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.#nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timeout });
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.#child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`,
    );
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null) return;
    this.#child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#child.kill("SIGTERM");
        resolve();
      }, 2_000);
      this.#child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function contractResponse(
  response: JsonRpcResponse,
): Omit<JsonRpcResponse, "id" | "jsonrpc"> {
  if (response.error !== undefined) return { error: response.error };
  return { result: response.result };
}

export async function captureMcpContract(command: McpCommand): Promise<McpContract> {
  const client = new RawMcpClient(command);
  try {
    const initialize = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "nomoreide-contract-snapshot",
        version: "1.0.0",
      },
    });
    if (initialize.error) {
      throw new Error(`MCP initialize failed: ${initialize.error.message}`);
    }
    client.notify("notifications/initialized");

    const listTools = await client.request("tools/list", {});
    if (listTools.error) {
      throw new Error(`MCP tools/list failed: ${listTools.error.message}`);
    }
    const tools = (listTools.result as { tools?: unknown[] }).tools;
    if (!Array.isArray(tools)) {
      throw new Error("MCP tools/list returned no tools array");
    }

    const requests = [
      {
        name: "documentation success",
        method: "tools/call",
        params: { name: "nomoreide_docs", arguments: { topic: "mcp" } },
      },
      {
        name: "schema validation error",
        method: "tools/call",
        params: { name: "nomoreide_docs", arguments: { topic: "not-a-topic" } },
      },
      {
        name: "unknown tool error",
        method: "tools/call",
        params: { name: "nomoreide_contract_missing_tool", arguments: {} },
      },
    ];
    const cases = [];
    for (const request of requests) {
      const response = await client.request(request.method, request.params);
      cases.push({
        name: request.name,
        request: { method: request.method, params: request.params },
        response: contractResponse(response),
      });
    }

    return {
      contractVersion: 1,
      initialize: initialize.result,
      tools,
      cases,
    };
  } finally {
    await client.close();
  }
}

/** Normalize only values known to vary between equivalent runtime invocations. */
export function normalizeMcpContract(
  value: unknown,
  options: McpNormalizationOptions = {},
): unknown {
  const paths = [...(options.temporaryPaths ?? [])].sort(
    (left, right) => right.length - left.length,
  );

  const visit = (current: unknown, key?: string): unknown => {
    if (key !== undefined && DYNAMIC_NUMBER_KEYS.has(key) && typeof current === "number") {
      return `<${key}>`;
    }
    if (key !== undefined && DYNAMIC_TIME_KEYS.has(key)) {
      return `<${key}>`;
    }
    if (typeof current === "string") {
      let normalized = current.replace(ISO_TIMESTAMP, "<timestamp>").replace(UUID, "<uuid>");
      for (const path of paths) normalized = normalized.replaceAll(path, "<temporary-path>");
      return normalized;
    }
    if (Array.isArray(current)) return current.map((item) => visit(item));
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([childKey, child]) => [childKey, visit(child, childKey)]),
      );
    }
    return current;
  };

  return visit(value);
}
