import { useState } from "react";
import { KeyRound } from "lucide-react";
import { setGitHubToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

export function GitHubTokenSetup({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await setGitHubToken("github.com", trimmed);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
          <KeyRound className="size-6 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Connect GitHub</h2>
          <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
            Enter a GitHub Personal Access Token (PAT) with{" "}
            <code className="rounded bg-muted px-1 py-px text-[11px]">repo</code> and{" "}
            <code className="rounded bg-muted px-1 py-px text-[11px]">workflow</code> scopes to
            view PRs, issues, and CI status.
          </p>
        </div>
      </div>

      <form className="flex w-full max-w-sm flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
        <input
          autoComplete="off"
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[13px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_..."
          spellCheck={false}
          type="password"
          value={token}
        />
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Button disabled={!token.trim() || saving} type="submit">
          {saving ? "Saving…" : "Save token"}
        </Button>
      </form>
    </div>
  );
}
