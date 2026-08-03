import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useToasts } from "@/components/ui/toast";
import {
  gitCreateBranch,
  gitDeleteBranch,
  gitFetch,
  gitMerge,
  gitPull,
  gitPush,
  gitRebase,
  gitSwitchBranch,
  type GitBranch as GitBranchInfo,
} from "@/lib/api";
import { useT, useTNodes } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Project-scoped branch control for the global breadcrumb. Branch selection is
 * available from every page because changing the checkout affects the whole
 * dashboard. Branch rows disclose an IDE-style target-specific action menu.
 */
export function BranchBreadcrumb({
  branches,
  currentBranch,
  ahead = 0,
  behind = 0,
  disabled,
  onRefresh,
  upstream,
}: {
  branches: GitBranchInfo[];
  currentBranch?: string;
  ahead?: number;
  behind?: number;
  disabled?: boolean;
  onRefresh: () => Promise<void>;
  upstream?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [createStartPoint, setCreateStartPoint] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [actionMenu, setActionMenu] = useState<{
    branchKey: string;
    left: number;
    top: number;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();

  const filteredBranches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return branches;
    return branches.filter((branch) => branch.name.toLowerCase().includes(normalizedQuery));
  }, [branches, query]);
  const localBranches = filteredBranches.filter((branch) => !branch.remote);
  const remoteBranches = filteredBranches.filter((branch) => branch.remote);
  const actionBranch = actionMenu
    ? branches.find(
        (branch) =>
          `${branch.remote ? "remote" : "local"}:${branch.name}` === actionMenu.branchKey,
      )
    : undefined;

  function closeMenus() {
    setOpen(false);
    setQuery("");
    setCreating(false);
    setCreateStartPoint(null);
    setNewBranch("");
    setActionMenu(null);
  }

  function toggle() {
    if (open) {
      closeMenus();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setCoords({
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)),
      });
    }
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target) ||
        actionMenuRef.current?.contains(target)
      ) {
        return;
      }
      closeMenus();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMenus();
      }
    }
    function onScroll(event: Event) {
      const target = event.target as Node;
      if (actionMenuRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) {
        setActionMenu(null);
        return;
      }
      closeMenus();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  async function switchBranch(name: string) {
    if (name === currentBranch || busy) return;
    setBusy(name);
    try {
      await gitSwitchBranch(name);
      await onRefresh();
      closeMenus();
      showSuccessToast(t("git.branch.switchedToast", { branch: name }));
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function runAction(key: string, action: () => Promise<string>) {
    if (busy) return;
    setBusy(key);
    try {
      const message = await action();
      await onRefresh();
      showSuccessToast(message);
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function createBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newBranch.trim();
    if (!name) {
      showErrorToast(t("git.branch.nameRequired"));
      return;
    }
    await runAction("create", async () => {
      await gitCreateBranch(name, createStartPoint ?? undefined);
      setCreating(false);
      setCreateStartPoint(null);
      setNewBranch("");
      setActionMenu(null);
      setOpen(false);
      setQuery("");
      return t("git.branch.createdToast", { branch: name });
    });
  }

  async function mergeBranch(name: string) {
    const target = currentBranch || t("git.branch.noBranch");
    if (!window.confirm(t("git.branch.mergeConfirm", { source: name, target }))) return;
    await runAction(`merge:${name}`, async () => {
      await gitMerge(name);
      return t("git.branch.mergedToast", { source: name, target });
    });
  }

  async function rebaseBranch(name: string) {
    const source = currentBranch || t("git.branch.noBranch");
    if (!window.confirm(t("git.branch.rebaseConfirm", { source, target: name }))) return;
    await runAction(`rebase:${name}`, async () => {
      await gitRebase(name);
      return t("git.branch.rebasedToast", { source, target: name });
    });
  }

  function createFromBranch(name: string) {
    setCreateStartPoint(name);
    setNewBranch("");
    setCreating(true);
    setActionMenu(null);
  }

  async function deleteBranch(name: string) {
    if (!window.confirm(t("git.branch.deleteConfirm", { branch: name }))) return;
    await runAction(`delete:${name}`, async () => {
      await gitDeleteBranch(name);
      setActionMenu(null);
      return t("git.branch.deletedToast", { branch: name });
    });
  }

  function toggleBranchActions(
    branch: GitBranchInfo,
    branchKey: string,
    anchor: HTMLButtonElement,
  ) {
    if (actionMenu?.branchKey === branchKey) {
      setActionMenu(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const gutter = 8;
    const gap = 4;
    const width = 288;
    const estimatedHeight = branch.remote ? 164 : 208;
    const right = rect.right + gap;
    const left =
      right + width <= window.innerWidth - gutter
        ? right
        : Math.max(gutter, rect.left - width - gap);
    setActionMenu({
      branchKey,
      left,
      top: Math.max(
        gutter,
        Math.min(rect.top, window.innerHeight - estimatedHeight - gutter),
      ),
    });
  }

  const label = currentBranch || t("git.branch.noBranch");

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("git.branch.switchAria")}
        className={cn(
          "flex h-7 min-w-0 max-w-48 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-left transition-colors hover:border-border hover:bg-muted disabled:pointer-events-none disabled:opacity-50",
          open && "border-border bg-muted",
        )}
        disabled={disabled}
        onClick={toggle}
        ref={triggerRef}
        title={t("git.branch.switchAria")}
        type="button"
      >
        <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-[11px]">{label}</span>
        {behind > 0 ? (
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center font-mono text-[9px] tabular-nums text-sky-500"
            title={t("git.board.behindTitle", { count: behind })}
          >
            <ArrowDown className="size-3" />
            {behind}
          </span>
        ) : null}
        {ahead > 0 ? (
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center font-mono text-[9px] tabular-nums text-emerald-500"
            title={t("git.board.aheadTitle", { count: ahead })}
          >
            <ArrowUp className="size-3" />
            {ahead}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open
        ? createPortal(
            <div
              aria-label={t("git.branch.switchAria")}
              className="fixed z-50 flex max-h-96 w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-md border border-border bg-card shadow-md"
              ref={menuRef}
              role="dialog"
              style={{ top: coords.top, left: coords.left }}
            >
              <div
                aria-label={t("git.branch.syncActions")}
                className="grid shrink-0 grid-cols-4 border-b border-border p-1"
                role="toolbar"
              >
                <QuickAction
                  busy={busy === "fetch"}
                  disabled={disabled || busy !== null}
                  icon={<RefreshCw />}
                  label={t("git.branch.fetch")}
                  onClick={() =>
                    void runAction("fetch", async () => {
                      await gitFetch();
                      return t("git.branch.fetched");
                    })
                  }
                />
                <QuickAction
                  busy={busy === "pull"}
                  disabled={disabled || busy !== null || !upstream}
                  icon={<ArrowDown className="text-sky-500" />}
                  label={behind > 0 ? `${t("git.branch.pull")} ${behind}` : t("git.branch.pull")}
                  onClick={() =>
                    void runAction("pull", async () => {
                      await gitPull();
                      return t("git.branch.pulled");
                    })
                  }
                />
                <QuickAction
                  busy={busy === "push"}
                  disabled={disabled || busy !== null || !currentBranch}
                  icon={<ArrowUp className="text-emerald-500" />}
                  label={ahead > 0 ? `${t("git.branch.push")} ${ahead}` : t("git.branch.push")}
                  onClick={() =>
                    void runAction("push", async () => {
                      const result = await gitPush();
                      return result.setUpstream
                        ? t("git.branch.pushedSetUpstream", { branch: result.branch })
                        : t("git.branch.pushed", { branch: result.branch || currentBranch || "" });
                    })
                  }
                />
                <QuickAction
                  busy={false}
                  disabled={disabled || busy !== null}
                  icon={<Plus />}
                  label={t("git.branch.new")}
                  onClick={() => {
                    setCreating((value) => !value);
                    setCreateStartPoint(null);
                    setNewBranch("");
                    setActionMenu(null);
                  }}
                />
              </div>
              {creating ? (
                <form
                  className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-1 border-b border-border p-2"
                  onSubmit={createBranch}
                >
                  {createStartPoint ? (
                    <span className="sr-only">
                      {t("git.branch.createFromHint", { branch: createStartPoint })}
                    </span>
                  ) : null}
                  <input
                    aria-label={t("git.branch.newNameAria")}
                    className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={busy !== null}
                    onChange={(event) => setNewBranch(event.target.value)}
                    placeholder={
                      createStartPoint
                        ? t("git.branch.createFromPlaceholder", { branch: createStartPoint })
                        : "feature/new-work"
                    }
                    value={newBranch}
                  />
                  <button
                    className="h-7 rounded bg-foreground px-2 text-[11px] font-medium text-background disabled:opacity-50"
                    disabled={busy !== null || !newBranch.trim()}
                    type="submit"
                  >
                    {busy === "create" ? (
                      <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      t("git.branch.create")
                    )}
                  </button>
                  {createStartPoint ? (
                    <span
                      className="col-span-2 truncate font-mono text-[9px] text-muted-foreground"
                      title={createStartPoint}
                    >
                      {t("git.branch.from", { branch: createStartPoint })}
                    </span>
                  ) : null}
                </form>
              ) : null}
              <label className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-2">
                <Search aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  aria-label={t("git.branch.searchPlaceholder")}
                  className="h-5 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActionMenu(null);
                  }}
                  placeholder={t("git.branch.searchPlaceholder")}
                  value={query}
                />
              </label>
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {filteredBranches.length ? (
                  <>
                    <BranchMenuSection
                      actionBranchKey={actionMenu?.branchKey ?? null}
                      branches={localBranches}
                      busy={busy}
                      currentBranch={currentBranch}
                      label={t("git.branch.sectionLocal")}
                      onActionToggle={toggleBranchActions}
                    />
                    <BranchMenuSection
                      actionBranchKey={actionMenu?.branchKey ?? null}
                      branches={remoteBranches}
                      busy={busy}
                      currentBranch={currentBranch}
                      label={t("git.branch.sectionRemote")}
                      onActionToggle={toggleBranchActions}
                    />
                  </>
                ) : (
                  <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                    {t("git.branch.noneFound")}
                  </p>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && actionMenu && actionBranch
        ? createPortal(
            <div
              className="fixed z-[60] w-72 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-card p-1 shadow-md"
              ref={actionMenuRef}
              style={{ left: actionMenu.left, top: actionMenu.top }}
            >
              <BranchActionMenu
                branch={actionBranch}
                busy={busy}
                current={actionBranch.current || actionBranch.name === currentBranch}
                currentBranch={currentBranch || t("git.branch.noBranch")}
                onCreateFrom={createFromBranch}
                onDelete={deleteBranch}
                onMerge={mergeBranch}
                onRebase={rebaseBranch}
                onSwitch={switchBranch}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function BranchMenuSection({
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

function BranchActionMenu({
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
  onDelete: (name: string) => Promise<void>;
  onMerge: (name: string) => Promise<void>;
  onRebase: (name: string) => Promise<void>;
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
        onClick={() => void onMerge(branch.name)}
      />
      <BranchMenuAction
        disabled={unavailable || current}
        icon={<GitCompareArrows />}
        label={tn("git.branch.rebaseCurrentOnto", {
          source: <BranchName name={currentBranch} />,
          target: <BranchName name={branch.name} />,
        })}
        onClick={() => void onRebase(branch.name)}
      />
      {!branch.remote ? (
        <>
          <div className="my-1 h-px bg-border/70" />
          <BranchMenuAction
            danger
            disabled={unavailable || current}
            icon={<Trash2 />}
            label={t("git.branch.deleteLocal")}
            onClick={() => void onDelete(branch.name)}
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
function BranchName({ name }: { name: string }) {
  return <span className="font-semibold text-foreground">{name}</span>;
}

function BranchMenuAction({
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

function QuickAction({
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
