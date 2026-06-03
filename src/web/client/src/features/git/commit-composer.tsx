import { useMemo, useState } from "react";
import { Check, Loader2, Upload } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { gitCommit, gitPush, type GitFileStatus } from "@/lib/api";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
import { buildCommitMessagePrompt } from "../agent/prompts";

/** Deterministic commit + push, with an AI assist for the message only. */
export function CommitComposer({
  branch,
  files,
  onDone,
}: {
  branch?: string;
  files: GitFileStatus[];
  /** Refresh the dashboard so the file list / ahead-behind reflect the commit. */
  onDone: () => void;
}) {
  const { sendToAgent } = useAgentDock();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"commit" | "push" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // A file has staged content when its index column is set to something other
  // than untracked ("?") or clean (" ") — matches what `git commit` will record.
  const stagedFiles = useMemo(
    () => files.filter((file) => file.index.trim() && file.index !== "?").map((file) => file.path),
    [files],
  );
  const canCommit = stagedFiles.length > 0 && message.trim().length > 0 && busy === null;

  async function run(label: "commit" | "push", push: boolean) {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      await gitCommit(message.trim());
      if (push) {
        const result = await gitPush();
        setDone(`Committed and pushed ${result.branch}.`);
      } else {
        setDone("Committed staged changes.");
      }
      setMessage("");
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  function suggestMessage() {
    sendToAgent({
      prompt: buildCommitMessagePrompt({ branch, stagedFiles }),
      source: { type: "git-commit", label: "commit message" },
      mode: "send",
      label: "Suggest a commit message",
    });
  }

  return (
    <div className="shrink-0 space-y-2 border-t border-border bg-card/95 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-tight text-muted-foreground">
          Commit
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">
            {stagedFiles.length} staged
          </span>
          <button
            aria-label="Suggest a commit message with AI"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            disabled={stagedFiles.length === 0}
            onClick={suggestMessage}
            title="Ask the agent to draft a commit message from the staged diff"
            type="button"
          >
            <AgentMark className="size-3.5" />
            AI message
          </button>
        </span>
      </div>

      <textarea
        aria-label="Commit message"
        className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/40 focus:ring-2 focus:ring-ring"
        onChange={(event) => {
          setMessage(event.target.value);
          setError(null);
          setDone(null);
        }}
        placeholder={stagedFiles.length ? "Commit message…" : "Stage files to commit"}
        value={message}
      />

      <div className="grid grid-cols-2 gap-2">
        <Button
          disabled={!canCommit}
          onClick={() => void run("commit", false)}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy === "commit" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Commit
        </Button>
        <Button
          disabled={!canCommit}
          onClick={() => void run("push", true)}
          size="sm"
          type="button"
        >
          {busy === "push" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          Commit &amp; push
        </Button>
      </div>

      {error ? (
        <Alert className="px-2.5 py-1.5 text-[11px]" variant="destructive">
          {error}
        </Alert>
      ) : done ? (
        <Alert className="px-2.5 py-1.5 text-[11px]" variant="muted">
          {done}
        </Alert>
      ) : null}
    </div>
  );
}
