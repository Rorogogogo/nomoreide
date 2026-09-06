import type { ReactNode, } from "react";
import {
  Check,
  ChevronRight,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { GitBranch as GitBranchInfo } from "@/lib/api";
import { useT, useTNodes } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The branch breadcrumb's menus: the per-branch action menu, its sections and
 * rows, and the confirm dialog a destructive action opens.
 *
 * Split out of `branch-breadcrumb.tsx`, which keeps the popover, the branch
 * list and the git calls the menus report back to. These render what they are
 * handed and call back — none of them talks to the API.
 */

export function BranchConfirm({
  currentBranch,
  onCancel,
  onConfirm,
  pending,
}: {
  currentBranch: string;
  onCancel: () => void;
  onConfirm: () => void;
  pending: { kind: "merge" | "rebase" | "delete"; branch: string };
}) {
  const t = useT();
  const copy =
    pending.kind === "merge"
      ? {
          title: t("git.branch.mergeTitle", { source: pending.branch, target: currentBranch }),
          message: t("git.branch.mergeConfirm"),
          confirm: t("git.branch.mergeAction"),
          icon: <GitMerge />,
          tone: "default" as const,
        }
      : pending.kind === "rebase"
        ? {
            title: t("git.branch.rebaseTitle", { source: currentBranch, target: pending.branch }),
            message: t("git.branch.rebaseConfirm"),
            confirm: t("git.branch.rebaseAction"),
            icon: <GitCompareArrows />,
            tone: "danger" as const,
          }
        : {
            title: t("git.branch.deleteTitle", { branch: pending.branch }),
            message: t("git.branch.deleteConfirm"),
            confirm: t("common.delete"),
            icon: <Trash2 className="text-destructive" />,
            tone: "danger" as const,
          };

  return (
    <ConfirmDialog
      cancelLabel={t("common.cancel")}
      confirmLabel={copy.confirm}
      icon={copy.icon}
      message={copy.message}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={copy.title}
      tone={copy.tone}
    />
  );
}

export function BranchMenuSection({
  actionBranchKey,
  branches,
  busy,
  currentBranch,
  label,
  onActionToggle,
}: {
  actionBranchKey: string | null;
  branches: GitBranchInfo[];
  busy: string | null;
  currentBranch?: string;
  label: string;
  onActionToggle: (
    branch: GitBranchInfo,
    key: string,
    anchor: HTMLButtonElement,
  ) => void;
}) {
  if (!branches.length) return null;
  return (
    <section aria-label={label}>
      <div className="px-2 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {branches.map((branch) => {
        const current = branch.current || branch.name === currentBranch;
        const branchKey = `${branch.remote ? "remote" : "local"}:${branch.name}`;
        const actionOpen = actionBranchKey === branchKey;
        return (
          <div
            className={cn(
              "w-full overflow-hidden rounded-sm transition-colors hover:bg-muted",
              current && "bg-muted/45",
              actionOpen && "bg-muted/35",
            )}
            key={branchKey}
          >
            <button
              aria-current={current ? "true" : undefined}
              aria-expanded={actionOpen}
              className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-xs disabled:opacity-60"
              disabled={busy !== null}
              onClick={(event) => onActionToggle(branch, branchKey, event.currentTarget)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{branch.name}</span>
              {busy?.endsWith(`:${branch.name}`) || busy === branch.name ? (
                <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
              ) : current ? (
                <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
              <ChevronRight
                aria-hidden="true"
                className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", actionOpen && "rotate-90")}
              />
            </button>
          </div>
        );
      })}
    </section>
  );
}

export function BranchActionMenu({
  branch,
  busy,
  current,
  currentBranch,
  onCreateFrom,
  onDelete,
  onMerge,
  onRebase,
  onSwitch,
}: {
  branch: GitBranchInfo;
  busy: string | null;
  current: boolean;
  currentBranch: string;
  onCreateFrom: (name: string) => void;
  onDelete: (name: string) => void;
  onMerge: (name: string) => void;
  onRebase: (name: string) => void;
  onSwitch: (name: string) => Promise<void>;
}) {
  const t = useT();
  const tn = useTNodes();
  const unavailable = busy !== null;
  return (
    <div
      aria-label={t("git.branch.actionsFor", { branch: branch.name })}
      role="menu"
    >
      <BranchMenuAction
        disabled={unavailable || current}
        icon={<GitBranch />}
        label={current ? t("git.branch.currentCheckout") : t("git.branch.checkout")}
        onClick={() => void onSwitch(branch.name)}
      />
      <BranchMenuAction
        disabled={unavailable}
        icon={<Plus />}
        label={tn("git.branch.createFrom", { branch: <BranchName name={branch.name} /> })}
        onClick={() => onCreateFrom(branch.name)}
      />
      <div className="my-1 h-px bg-border/70" />
      <BranchMenuAction
        disabled={unavailable || current}
        icon={<GitMerge />}
        label={tn("git.branch.mergeIntoCurrent", {
          source: <BranchName name={branch.name} />,
          target: <BranchName name={currentBranch} />,
        })}
        onClick={() => onMerge(branch.name)}
      />
      <BranchMenuAction
        disabled={unavailable || current}
        icon={<GitCompareArrows />}
        label={tn("git.branch.rebaseCurrentOnto", {
          source: <BranchName name={currentBranch} />,
          target: <BranchName name={branch.name} />,
        })}
        onClick={() => onRebase(branch.name)}
      />
      {!branch.remote ? (
        <>
          <div className="my-1 h-px bg-border/70" />
          <BranchMenuAction
            danger
            disabled={unavailable || current}
            icon={<Trash2 />}
            label={t("git.branch.deleteLocal")}
            onClick={() => onDelete(branch.name)}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * A branch name inside a menu sentence. These rows are mostly connective words
 * ("Merge … into …") wrapped around the names that actually differ between
 * them, and long names get truncated — so the names are weighted to stay
 * findable at a glance rather than reading as one grey run-on line.
 */
export function BranchName({ name }: { name: string }) {
  return <span className="font-semibold text-foreground">{name}</span>;
}

export function BranchMenuAction({
  danger = false,
  disabled,
  icon,
  label,
  onClick,
}: {
  danger?: boolean;
  disabled: boolean;
  icon: ReactNode;
  label: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted disabled:opacity-40 [&_svg]:size-3.5",
        danger && "text-destructive hover:bg-destructive/10",
      )}
      disabled={disabled}
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      <span aria-hidden="true" className="shrink-0 text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

export function QuickAction({
  busy,
  disabled,
  icon,
  label,
  onClick,
}: {
  busy: boolean;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex h-8 min-w-0 items-center justify-center gap-1 rounded text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {busy ? (
        <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
      ) : (
        <span aria-hidden="true" className="contents">
          {icon}
        </span>
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}
