/** A short, asset-free two-note chime. It never leaves the browser or reads a file. */
export function playAgentCompletionChime(): void {
  if (typeof window === "undefined") return;
  const AudioContextClass = window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;

  try {
    const context = new AudioContextClass();
    const gain = context.createGain();
    gain.connect(context.destination);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.42);

    for (const [frequency, offset] of [[659.25, 0], [880, 0.12]] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, context.currentTime + offset);
      oscillator.connect(gain);
      oscillator.start(context.currentTime + offset);
      oscillator.stop(context.currentTime + offset + 0.28);
    }

    void context.resume()
      .then(() => new Promise<void>((resolve) => window.setTimeout(resolve, 500)))
      .then(() => context.close())
      .catch(() => context.close().catch(() => undefined));
  } catch {
    // Browsers may reject audio until the page has received a user gesture.
  }
}
