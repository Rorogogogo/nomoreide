export function initialAgentInputSequence(prompt: string): [string, string] {
  return [`\u001b[200~${prompt}\u001b[201~`, "\r"];
}

export function initialAgentSubmitDelay(provider: "claude" | "codex"): number {
  return provider === "claude" ? 500 : 75;
}
