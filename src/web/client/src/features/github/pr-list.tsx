import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import type { GitHubPR } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { LoadMoreButton } from "./load-more-button";

export function PrList({
  prs,
  loading,
  loadingMore,
  hasMore,
  error,
  selectedNumber,
  onSelect,
  onLoadMore,
}: {
  prs: GitHubPR[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  selectedNumber: number | null;
  onSelect: (number: number) => void;
  onLoadMore: () => void;
}) {
  const t = useT();
  if (loading && prs.length === 0) {
    return <div className="p-4 text-[12px] text-muted-foreground">{t("github.prs.loading")}</div>;
  }
  if (error) {
    return <div className="p-4 text-[12px] text-red-500">{error}</div>;
  }
  if (prs.length === 0) {
    return <div className="p-4 text-[12px] text-muted-foreground">{t("github.prs.empty")}</div>;
  }

  return (
    <>
      <ul className="divide-y divide-border">
      {prs.map((pr) => (
        <li key={pr.number}>
          <button
            className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 ${
              selectedNumber === pr.number ? "bg-muted" : ""
            }`}
            onClick={() => onSelect(pr.number)}
            type="button"
          >
            <span className="mt-0.5 shrink-0">
              <PrStateIcon pr={pr} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{pr.title}</span>
              <span className="block text-[11px] text-muted-foreground">
                #{pr.number} · {pr.base.ref} ← {pr.head.ref} · {pr.user.login}
              </span>
            </span>
            {pr.draft ? (
              <span className="shrink-0 rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                {t("github.prs.draft")}
              </span>
            ) : null}
          </button>
        </li>
      ))}
      </ul>
      <LoadMoreButton hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
    </>
  );
}

function PrStateIcon({ pr }: { pr: GitHubPR }) {
  if (pr.state === "merged") {
    return <GitMerge className="size-4 text-purple-500" />;
  }
  if (pr.state === "closed") {
    return <GitPullRequestClosed className="size-4 text-red-500" />;
  }
  return <GitPullRequest className="size-4 text-emerald-500" />;
}
