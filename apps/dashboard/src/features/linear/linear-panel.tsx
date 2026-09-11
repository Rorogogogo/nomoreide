import { useState, type ReactNode } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { SelectMenu } from "@/components/ui/select-menu";
import { StateFilter, TabStrip } from "@/components/ui/tab-strip";
import { cn } from "@/lib/utils";
import { BindingToggle } from "./linear-binding";
import { LinearBoard } from "./linear-board";
import { LinearDetail } from "./linear-detail";
import { LinearList } from "./linear-list";
import { PRIORITIES } from "./linear-states";
import type { LinearIssue, LinearTransport } from "./linear-types";
import { rememberedView, rememberView, useLinearTasks } from "./use-linear-tasks";

type View = "list" | "board";

const QUIET =
  "shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * Linear tasks, as a list or as a board.
 *
 * **One chrome strip, not three.** The previous version stacked a connection
 * bar on a selector bar on a filter column, in default-sized form controls —
 * three headers and a `text-sm` list on a panel whose neighbours are 11px. This
 * is the single toolbar DESIGN.md asks for: view tabs, then scope (team,
 * project), then filters, then actions, separated by inset hairlines rather
 * than by being put in boxes. Those four groups are also the wrap unit — a
 * narrow panel stacks them as rows, it does not break one apart.
 */
export function LinearPanel({
  onDisconnect,
  send,
  t,
  taskAction,
}: {
  onDisconnect?: ReactNode;
  send: LinearTransport;
  t: (key: string, params?: Record<string, string | number>) => string;
  taskAction?: (issue: LinearIssue) => ReactNode;
}) {
  const m = useLinearTasks(send);
  const [view, setView] = useState<View>(rememberedView);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [composing, setComposing] = useState<"task" | "project" | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const team = m.teams.find((entry) => entry.id === m.team);
  const states = team?.states.nodes ?? [];
  const query = search.trim().toLowerCase();
  const visible = m.issues.filter(
    (issue) =>
      // The board shows every column, so a status filter there would empty
      // columns rather than filter them — it belongs to the list only.
      (view === "board" || !status || issue.state.id === status) &&
      (!priority || issue.priority === Number(priority)) &&
      (!query ||
        `${issue.identifier} ${issue.title} ${issue.assignee?.name ?? ""}`
          .toLowerCase()
          .includes(query)),
  );

  return (
    <section className="@container/panel flex h-full min-h-0 flex-col">
      {/*
        One strip that wraps rather than one strip that scrolls. The controls
        keep their reading widths and drop to a second row when the panel is
        narrow — the previous single line let flexbox shrink the team and
        project pickers to a bare chevron and clipped the search field, which
        is a toolbar you cannot use rather than a toolbar that is tight.

        Sized against the toolbar's own width with `@container`, not the
        viewport's: this panel sits beside a sidebar and an agent dock, so the
        window can be wide while the strip is not.
      */}
      <div className="@container/toolbar flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <TabStrip
            ariaLabel={t("view")}
            idPrefix="linear"
            onSelect={(next) => {
              setView(next);
              rememberView(next);
            }}
            tabs={[
              { id: "list", label: t("viewList") },
              { id: "board", label: t("viewBoard") },
            ]}
            value={view}
          />
          <span aria-hidden="true" className="mx-1 h-3 w-px shrink-0 bg-border" />

          <SelectMenu
            ariaLabel={t("team")}
            className="w-28 min-w-20 shrink @2xl/toolbar:w-36"
            disabled={m.busy}
            // The binding lives on the control that chooses the thing being
            // bound. It was a "Link to repository" button in the toolbar, which
            // named no repository, showed no state, and gave no feedback when
            // pressed — three reasons nobody could tell what it did.
            footer={<BindingToggle m={m} t={t} />}
            onChange={(next) => {
              m.selectTeam(next);
              setStatus("");
            }}
            options={m.teams.map((entry) => ({ value: entry.id, label: entry.name }))}
            placeholder={t("team")}
            value={m.team || null}
          />
          <SelectMenu
            ariaLabel={t("project")}
            className="w-28 min-w-20 shrink @2xl/toolbar:w-36"
            disabled={m.busy || !m.team}
            onChange={m.setProject}
            options={[
              { value: "", label: t("allProjects") },
              ...(team?.projects.nodes.map((entry) => ({ value: entry.id, label: entry.name })) ??
                []),
            ]}
            // Creating a project belongs on the control that picks one — the
            // same reasoning that moved the repository binding into the team
            // menu. It closes the menu, because unlike the binding tick it
            // starts something rather than setting something.
            footer={(close) => (
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!m.team || m.busy}
                onClick={() => {
                  close();
                  setTitle("");
                  setDescription("");
                  setComposing("project");
                }}
                type="button"
              >
                <Plus aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{t("newProject")}</span>
              </button>
            )}
            placeholder={t("allProjects")}
            value={m.project}
          />
        </div>

        {/* Filters get a row to themselves until the strip is wide enough for
            the whole toolbar, so the search field grows into the slack instead
            of collapsing — and `order-last` keeps that row below the actions
            rather than splitting them across three. 1320px is where all four
            groups genuinely fit side by side; below it the single strip only
            fits by squashing something. */}
        <div className="order-last flex min-w-0 flex-1 basis-full flex-wrap items-center gap-x-2 gap-y-1.5 @min-[1320px]/toolbar:order-none @min-[1320px]/toolbar:basis-64">
          <span
            aria-hidden="true"
            className="mx-1 hidden h-3 w-px shrink-0 bg-border @min-[1320px]/toolbar:block"
          />
          <input
            aria-label={t("search")}
            className="min-w-32 flex-1 bg-transparent text-[11px] placeholder:text-muted-foreground focus-visible:outline-none"
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("search")}
            value={search}
          />

          {view === "list" && (
            <SelectMenu
              ariaLabel={t("status")}
              className="w-28 shrink-0 @2xl/toolbar:w-32"
              onChange={setStatus}
              options={[
                { value: "", label: t("allStatuses") },
                ...states.map((state) => ({ value: state.id, label: state.name })),
              ]}
              placeholder={t("allStatuses")}
              value={status}
            />
          )}
          {/* Five segments are wider than a narrow panel; let them scroll
              inside their own track rather than force the strip wider. */}
          <div className="min-w-0 max-w-full overflow-x-auto">
            <StateFilter
              ariaLabel={t("priority")}
              onChange={setPriority}
              options={[
                { id: "", label: t("allPriorities") },
                ...PRIORITIES.filter((value) => value > 0).map((value) => ({
                  id: String(value),
                  label: t(`priority${value}`),
                })),
              ]}
              value={priority}
            />
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="mx-1 hidden h-3 w-px shrink-0 bg-border @min-[1320px]/toolbar:block"
          />
          <button
            aria-label={t("create")}
            className={QUIET}
            disabled={!m.team || m.busy}
            onClick={() => setComposing((open) => (open === "task" ? null : "task"))}
            title={t("create")}
            type="button"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            aria-label={t("refresh")}
            className={QUIET}
            disabled={!m.team || m.busy}
            onClick={() => void m.run(() => m.refresh())}
            title={t("refresh")}
            type="button"
          >
            <RefreshCw className={cn("size-3.5", m.busy && "animate-spin")} />
          </button>
          {onDisconnect}
        </div>
      </div>

      {m.error && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1">
          <p className="text-[11px] text-red-600 dark:text-red-500" role="alert">
            {m.error}
          </p>
          {m.teams.length === 0 && (
            <button className={QUIET} disabled={m.busy} onClick={() => void m.reloadMetadata()} type="button">
              {t("refresh")}
            </button>
          )}
        </div>
      )}

      {composing && (
        <form
          className="flex items-center gap-2 border-b border-border px-3 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const saving =
              composing === "project"
                ? m.createProject(title, description)
                : m.create(title, description);
            void saving.then((saved) => {
              if (saved) {
                setTitle("");
                setDescription("");
                setComposing(null);
              }
            });
          }}
        >
          <input
            aria-label={t(composing === "project" ? "projectName" : "title")}
            className="min-w-0 flex-1 bg-transparent text-[11px] placeholder:text-muted-foreground focus-visible:outline-none"
            maxLength={512}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t(composing === "project" ? "projectName" : "title")}
            required
            value={title}
          />
          <input
            aria-label={t("description")}
            className="min-w-0 flex-1 bg-transparent text-[11px] placeholder:text-muted-foreground focus-visible:outline-none"
            maxLength={16000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("description")}
            value={description}
          />
          <button className={QUIET} disabled={!title.trim() || m.busy} type="submit">
            {t(composing === "project" ? "createProject" : "create")}
          </button>
          <button className={QUIET} onClick={() => setComposing(null)} type="button">
            {t("cancel")}
          </button>
        </form>
      )}

      {view === "board" ? (
        <div className="flex min-h-0 flex-1">
          <div className={cn("flex min-h-0 min-w-0 flex-1", m.issue && "hidden @3xl/panel:flex")}>
            <LinearBoard
              busy={m.busy}
              issues={visible}
              onDragBegin={m.closeIssue}
              onPlace={(id, state, sortOrder) => void m.placeIssue(id, state, sortOrder)}
              onSelect={(id) => void m.selectIssue(id)}
              selectedId={m.issue?.id}
              showProject={!m.project}
              states={states}
              t={t}
            />
          </div>
          {/* Beside the board, not over it. A real boundary between two
              regions, so a full-height border rather than an inset hairline —
              and it closes the moment a drag starts, because a column hidden
              behind it is a column you cannot drop into. Under a panel width
              that cannot hold both, it takes the panel instead: 384px of detail
              beside 250px of board is two unusable regions rather than two. */}
          {m.issue && (
            <section className="flex w-full min-w-0 shrink-0 flex-col @3xl/panel:w-96 @3xl/panel:border-l @3xl/panel:border-border">
              <LinearDetail
                busy={m.busy}
                issue={m.issue}
                onBack={m.closeIssue}
                onComment={m.comment}
                onStateChange={(state) => void m.update(state.id)}
                pending={m.detailPending}
                states={states}
                t={t}
                taskAction={taskAction}
                trailing={
                  <button
                    aria-label={t("close")}
                    // Hidden where the detail owns the panel: the header's own
                    // "back" is already there, and two controls that do the
                    // same thing read as two different ones.
                    className="hidden shrink-0 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @3xl/panel:block"
                    onClick={m.closeIssue}
                    type="button"
                  >
                    <X className="size-3.5" />
                  </button>
                }
              />
            </section>
          )}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 @3xl/panel:grid-cols-2 @3xl/panel:divide-x @3xl/panel:divide-border">
          {/* Queried against the panel, not the viewport: `md:` kept the split
              open whenever the *window* was wide, so a narrow panel beside an
              open agent dock showed two half-legible columns. */}
          <div className={cn("flex min-h-0 flex-col", m.issue && "hidden @3xl/panel:flex")}>
            <LinearList
              busy={m.busy}
              cursor={m.cursor}
              emptyLabel={t("empty")}
              issues={visible}
              moreLabel={t("more")}
              onMore={() => void m.run(() => m.refresh(m.cursor ?? undefined))}
              onSelect={(id) => void m.selectIssue(id)}
              selectedId={m.issue?.id}
              showProject={!m.project}
              t={t}
            />
          </div>
          <div className={cn("flex min-h-0 flex-col", !m.issue && "hidden @3xl/panel:flex")}>
            {m.issue ? (
              <LinearDetail
                busy={m.busy}
                issue={m.issue}
                onBack={m.closeIssue}
                onComment={m.comment}
                onStateChange={(state) => void m.update(state.id)}
                pending={m.detailPending}
                states={states}
                t={t}
                taskAction={taskAction}
              />
            ) : (
              <p className="px-3 py-4 text-[12px] text-muted-foreground">{t("select")}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
