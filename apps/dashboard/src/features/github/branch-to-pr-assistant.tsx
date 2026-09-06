import { useEffect, useState } from "react";
import {
  createGitHubPR,
  getGitHubPRTemplate,
  type GitHubPR,
  type GitHubPRTemplate,
} from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useT, } from "@/lib/i18n";

/**
 * The prompt that appears when the checked-out branch has no PR yet: what it
 * would compare against, and a one-click open.
 */

export function BranchToPRAssistant({
  initialHead,
  onCreated,
  onCancel,
}: {
  initialHead?: string;
  onCreated: (pr: GitHubPR) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [head, setHead] = useState("");
  const [base, setBase] = useState("main");
  const [draft, setDraft] = useState(false);
  const [template, setTemplate] = useState<GitHubPRTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getGitHubPRTemplate()
      .then((next) => {
        if (!active) return;
        setTemplate(next);
        setTitle(next.title);
        setBody(next.body);
        setHead(initialHead || next.head);
        setBase(next.base || next.suggestedBase || "main");
        setDraft(next.draft);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [initialHead]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !head.trim() || !base.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createGitHubPR({
        title: title.trim(),
        body: body.trim() || undefined,
        head: head.trim(),
        base: base.trim(),
        draft,
      });
      onCreated(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const warnings = template?.warnings ?? [];

  return (
    <form className="flex min-h-0 flex-col gap-3 overflow-auto bg-muted/20 p-4" onSubmit={(e) => void handleSubmit(e)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold">{t("github.branchToPr")}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {template?.repository?.full_name ?? t("github.selectedRepo")}
            {template?.currentBranch ? ` - ${template.currentBranch}` : ""}
          </p>
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {loading ? t("github.detectingBranch") : t("github.editableDraft")}
        </span>
      </div>

      <CompareSummary template={template} loading={loading} />

      {warnings.length > 0 ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
          {warnings[0]}
        </div>
      ) : null}

      <input className={fieldClass} disabled={loading} onChange={(e) => setTitle(e.target.value)} placeholder={t("github.fieldTitle")} required value={title} />
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground">{t("github.head")}</span>
          <input className={fieldClass} disabled={loading} onChange={(e) => setHead(e.target.value)} placeholder={t("github.headBranch")} required value={head} />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground">{t("github.base")}</span>
          <input className={fieldClass} disabled={loading} onChange={(e) => setBase(e.target.value)} placeholder={t("github.baseBranch")} required value={base} />
        </label>
      </div>
      <textarea
        className={`${fieldClass} resize-none`}
        disabled={loading}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t("github.descriptionOptional")}
        rows={7}
        value={body}
      />
      <label className="flex items-center gap-2 text-[12px]">
        <input checked={draft} className="size-3.5" disabled={loading} onChange={(e) => setDraft(e.target.checked)} type="checkbox" />
        {t("github.createAsDraft")}
      </label>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button disabled={loading || submitting || !title.trim() || !head.trim() || !base.trim()} type="submit">{submitting ? t("github.creating") : t("github.createPr")}</Button>
        <Button onClick={onCancel} type="button" variant="outline">{t("common.cancel")}</Button>
      </div>
    </form>
  );
}

export function CompareSummary({
  template,
  loading,
}: {
  template: GitHubPRTemplate | null;
  loading: boolean;
}) {
  const t = useT();
  const compare = template?.compare;
  const ci = compare?.ciStatus;
  const items = [
    { label: t("github.compare.base"), value: compare?.base || template?.base || "main" },
    { label: t("github.compare.head"), value: compare?.head || template?.head || "manual" },
    { label: t("github.compare.ahead"), value: loading ? "..." : String(compare?.aheadBy ?? 0) },
    { label: t("github.compare.changed"), value: loading ? "..." : String(compare?.files.length ?? 0) },
    { label: t("github.compare.ci"), value: ci ? `${ci.state} (${ci.totalCount})` : t("github.compare.unavailable") },
  ];

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">{t("github.compareSummary")}</span>
        {compare?.headSha ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {compare.headSha.slice(0, 7)}
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-5 gap-2">
        {items.map((item) => (
          <div className="min-w-0" key={item.label}>
            <div className="truncate text-[10px] uppercase text-muted-foreground">{item.label}</div>
            <div className="truncate font-mono text-[11px] text-foreground">{item.value}</div>
          </div>
        ))}
      </div>
      {compare?.files.length ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {compare.files.slice(0, 4).map((file) => (
            <span className="max-w-52 truncate" key={`${file.status}:${file.path}`}>
              {file.status} {file.path}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
