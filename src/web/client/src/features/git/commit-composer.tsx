import { useMemo, useState } from "react";
import { Check, Loader2, Upload } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { gitCommit, gitPush, type GitFileStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AiContextTarget } from "../agent/context-menu/ai-context-menu";
import { buildCommitMessagePrompt } from "../agent/prompts";

/** Deterministic commit + push, with an AI assist for the message only. */
export function CommitComposer({
  branch,
  files,
  onDone,
  repo,
}: {
  branch?: string;
  files: GitFileStatus[];
  /** Refresh the dashboard so the file list / ahead-behind reflect the commit. */
  onDone: () => void;
  /** Scope the commit/push to a named board repository (board columns). */
  repo?: string;
}) {
  const t = useT();
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
      await gitCommit(message.trim(), repo);
      if (push) {
        const result = await gitPush(repo);
        setDone(t("git.commit.committedPushed", { branch: result.branch }));
      } else {
        setDone(t("git.commit.committed"));
      }
      setMessage("");
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <AiContextTarget
      target={{
        label: t("git.commit.title"),
        intents: stagedFiles.length > 0 ? [{
          id: "suggest-commit-message",
          label: t("git.commit.aiMessage"),
          resolvePrompt: () => buildCommitMessagePrompt({ branch, stagedFiles }),
          source: { type: "git-commit", label: t("git.commit.sourceLabel") },
          agentLabel: t("git.commit.suggestLabel"),
        }] : [],
      }}
    >
    <div className="shrink-0 space-y-2 border-t border-border bg-card/95 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-tight text-muted-foreground">
          {t("git.commit.title")}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {t("git.commit.stagedCount", { count: stagedFiles.length })}
        </span>
      </div>

      <textarea
        aria-label={t("git.commit.messageAria")}
        className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/40 focus:ring-2 focus:ring-ring"
        onChange={(event) => {
          setMessage(event.target.value);
          setError(null);
          setDone(null);
        }}
        placeholder={stagedFiles.length ? t("git.commit.messagePlaceholder") : t("git.commit.stagePrompt")}
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
          {t("git.commit.commit")}
        </Button>
        <Button
          disabled={!canCommit}
          onClick={() => void run("push", true)}
          size="sm"
          type="button"
        >
          {busy === "push" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          {t("git.commit.commitPush")}
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
    </AiContextTarget>
  );
}
