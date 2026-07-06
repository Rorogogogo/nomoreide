/**
 * Barrel for the web client's API layer. Consumers import from `@/lib/api`
 * and never need to know which domain file a symbol lives in.
 *
 * To add an endpoint: extend the relevant domain module (`agent`, `errors`,
 * `git`, `services`) or add a new one and re-export it here. Low-level
 * transport (`requestJson`, form helpers) stays in `client.ts`.
 */
export { PortConflictResponseError, postForm } from "./client.js";
export type { PortConflictDetail } from "./client.js";

export * from "./agent.js";
export * from "./agent-chat.js";
export * from "./agent-env.js";
export * from "./database.js";
export * from "./errors.js";
export * from "./git.js";
export * from "./github.js";
export * from "./log-sources.js";
export * from "./onboard.js";
export * from "./services.js";
export * from "./snapshots.js";
export * from "./terminal.js";
export * from "./workflows.js";
