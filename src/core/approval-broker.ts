/**
 * Bridges Claude Code's PreToolUse permission hook to the web UI. The hook
 * (a child process of the spawned `claude`) POSTs an approval request and
 * blocks; the broker emits it onto the active chat SSE stream and parks a
 * resolver until the browser POSTs the user's decision back.
 *
 * Keyed by Claude Code session id, which both the SSE stream (from the init
 * event) and the hook (from its stdin payload) know.
 */

export interface ApprovalRequest {
  requestId: string;
  name: string;
  input: unknown;
}

export interface ApprovalDecision {
  decision: "allow" | "deny";
  reason?: string;
}

interface Channel {
  emit: (request: ApprovalRequest) => void;
  pending: Map<string, (decision: ApprovalDecision) => void>;
}

export class ApprovalBroker {
  private readonly channels = new Map<string, Channel>();

  /** Register the SSE emitter for a session so approvals can reach the browser. */
  openRun(sessionId: string, emit: (request: ApprovalRequest) => void): void {
    this.channels.set(sessionId, { emit, pending: new Map() });
  }

  /** Tear down a session, auto-denying anything still awaiting a decision. */
  closeRun(sessionId: string): void {
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    for (const resolve of channel.pending.values()) {
      resolve({ decision: "deny", reason: "The agent session ended before you responded." });
    }
    this.channels.delete(sessionId);
  }

  /** Called by the hook endpoint. Resolves once the user decides (or no channel). */
  requestApproval(
    sessionId: string | undefined,
    requestId: string,
    name: string,
    input: unknown,
  ): Promise<ApprovalDecision> {
    const channel = sessionId ? this.channels.get(sessionId) : undefined;
    if (!channel) {
      return Promise.resolve({ decision: "deny", reason: "No active agent session to approve." });
    }
    return new Promise((resolve) => {
      channel.pending.set(requestId, resolve);
      channel.emit({ requestId, name, input });
    });
  }

  /** Called by the browser. Returns false if the request is unknown/expired. */
  resolve(sessionId: string, requestId: string, decision: ApprovalDecision): boolean {
    const channel = this.channels.get(sessionId);
    const resolver = channel?.pending.get(requestId);
    if (!channel || !resolver) return false;
    channel.pending.delete(requestId);
    resolver(decision);
    return true;
  }
}
