/** Remote control: pairing this machine, and whether it is attached. */
import { requestJson } from "./client.js";

export interface RemoteRelaySnapshot {
  connected: boolean;
  deviceName?: string;
  lastError?: string | null;
  stopped?: boolean;
}

export interface RemoteStatus {
  ok: boolean;
  paired: boolean;
  deviceName?: string | null;
  deviceId?: string | null;
  platformBaseUrl?: string | null;
  relay?: RemoteRelaySnapshot | null;
}

export interface RemotePairingStart {
  ok: boolean;
  /** The short code a human types on their phone. */
  userCode?: string;
  verificationUrl?: string;
  /**
   * The verification link as a QR module grid, already encoded by the daemon.
   *
   * Absent when the link would not fit a code — the picture is an accelerant,
   * never the only way in, so the panel still shows the link and the code.
   */
  verificationQr?: QrMatrix | null;
  expiresAt?: string;
  deviceName?: string;
  error?: string;
}

/** One QR code, as squares. See `features/remote/pairing-qr.tsx`. */
export interface QrMatrix {
  size: number;
  rows: string[];
}

/**
 * Where a pairing has got to.
 *
 * `paired` is terminal and arrives with the device's name — the daemon
 * completes the exchange itself rather than handing a claimed-but-unexchanged
 * pairing back to the browser, which is the state that leaves a device on an
 * account with no credential on the machine.
 */
export interface RemotePairingProgress {
  ok: boolean;
  status: "pending" | "paired" | "expired" | "failed" | "noPairingInProgress";
  deviceName?: string;
  error?: string;
}

export function getRemoteStatus(): Promise<RemoteStatus> {
  return requestJson<RemoteStatus>("/api/remote/status");
}

export function startRemotePairing(): Promise<RemotePairingStart> {
  return requestJson<RemotePairingStart>("/api/remote/pair", { method: "POST" });
}

export function pollRemotePairing(): Promise<RemotePairingProgress> {
  return requestJson<RemotePairingProgress>("/api/remote/pair/poll", {
    method: "POST",
  });
}

export function unpairRemote(): Promise<{ ok: boolean; wasPaired?: boolean }> {
  return requestJson<{ ok: boolean; wasPaired?: boolean }>("/api/remote/pair", {
    method: "DELETE",
  });
}
