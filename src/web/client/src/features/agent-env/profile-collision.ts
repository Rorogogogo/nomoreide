/**
 * The daemon reports a name clash as `Profile "<name>" already exists`, for both
 * archive imports and registry installs. Both flows offer a replace/cancel
 * prompt, so the name is pulled out of the message here rather than twice.
 */
export function profileNameFromCollision(message: string): string {
  return message.match(/Profile\s+["“]([^"”]+)["”]\s+already exists/i)?.[1] ?? "this profile";
}

/** True when an error came back from a name clash rather than a real failure. */
export function isProfileCollision(message: string): boolean {
  return message.includes("already exists");
}
