import { useState, type ReactNode } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { SelectMenu } from "@/components/ui/select-menu";
import { StateFilter, TabStrip } from "@/components/ui/tab-strip";
import { cn } from "@/lib/utils";
import { LinearBoard } from "./linear-board";
import { LinearDetail } from "./linear-detail";
import { LinearList } from "./linear-list";
import { PRIORITIES } from "./linear-states";
import type { LinearIssue, LinearTransport } from "./linear-types";
import { useLinearTasks } from "./use-linear-tasks";

type View = "list" | "board";

const QUIET =
  "shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * Linear tasks, as a list or as a board.
 *
 * **One chrome strip, not three.** The previous version stacked a connection
 * bar on a selector bar on a filter column, in default-sized form controls —
 * three headers and a `text-sm` list on a panel whose neighbours are 11px. This
 * is the single `py-1` toolbar DESIGN.md asks for: view tabs, then scope
 * (team, project), then filters, then actions, separated by inset hairlines
 * rather than by being put in boxes.
 */
export function LinearPanel({
  onDisconnect,
  send,
  t,
  taskAction,
}: {
  onDisconnect?: ReactNode;
  send: LinearTransport;
  t: (key: string) => string;
  taskAction?: (issue: LinearIssue) => ReactNode;
}) {
  const m = useLinearTasks(send);
  const [view, setView] = useState<View>("list");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [composing, setComposing] = useState(false);
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
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 overflow-x-auto border-b border-border px-3 py-1">
        <TabStrip
          ariaLabel={t("view")}
          idPrefix="linear"
          onSelect={setView}
          tabs={[
            { id: "list", label: t("viewList") },
            { id: "board", label: t("viewBoard") },
          ]}
          value={view}
        />
        <span aria-hidden="true" className="mx-1 h-3 w-px shrink-0 bg-border" />

        <SelectMenu
          ariaLabel={t("team")}
          className="w-36"
          disabled={m.busy}
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
          className="w-36"
          disabled={m.busy || !m.team}
          onChange={m.setProject}
          options={[
            { value: "", label: t("allProjects") },
            ...(team?.projects.nodes.map((entry) => ({ value: entry.id, label: entry.name })) ?? []),
          ]}
          placeholder={t("allProjects")}
          value={m.project}
        />

        <span aria-hidden="true" className="mx-1 h-3 w-px shrink-0 bg-border" />
        <input
          aria-label={t("search")}
          className="min-w-24 flex-1 bg-transparent text-[11px] placeholder:text-muted-foreground focus-visible:outline-none"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("search")}
          value={search}
        />

        {view === "list" && (
          <SelectMenu
            ariaLabel={t("status")}
            className="w-32"
            onChange={setStatus}
            options={[
              { value: "", label: t("allStatuses") },
              ...states.map((state) => ({ value: state.id, label: state.name })),
            ]}
            placeholder={t("allStatuses")}
            value={status}
          />
        )}
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

        <span aria-hidden="true" className="mx-1 h-3 w-px shrink-0 bg-border" />
        <button
          aria-label={t("create")}
          className={QUIET}
          disabled={!m.team || m.busy}
          onClick={() => setComposing((open) => !open)}
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
        <button className={QUIET} disabled={!m.team || m.busy} onClick={() => void m.link()} type="button">
          {t("link")}
        </button>
        {onDisconnect}
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
            void m.create(title, description).then((saved) => {
              if (saved) {
                setTitle("");
                setDescription("");
                setComposing(false);
              }
            });
          }}
        >
          <input
            aria-label={t("title")}
            className="min-w-0 flex-1 bg-transparent text-[11px] placeholder:text-muted-foreground focus-visible:outline-none"
            maxLength={512}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("title")}
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
            {t("create")}
          </button>
        </form>
      )}

      {view === "board" ? (
        <div className="flex min-h-0 flex-1">
          <LinearBoard
            busy={m.busy}
            issues={visible}
            onDragBegin={m.closeIssue}
            onMove={(id, state) => void m.moveIssue(id, state)}
            onSelect={(id) => void m.selectIssue(id)}
            selectedId={m.issue?.id}
            states={states}
            t={t}
          />
          {/* Beside the board, not over it. A real boundary between two
              regions, so a full-height border rather than an inset hairline —
              and it closes the moment a drag starts, because a column hidden
              behind it is a column you cannot drop into. */}
          {m.issue && (
            <section className="flex w-96 min-w-0 shrink-0 flex-col border-l border-border">
              <LinearDetail
                busy={m.busy}
                issue={m.issue}
                onBack={m.closeIssue}
                onComment={m.comment}
                onStateChange={(state) => void m.update(state.id)}
                states={states}
                t={t}
                taskAction={taskAction}
                trailing={
                  <button
                    aria-label={t("close")}
                    className="shrink-0 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <div className="grid min-h-0 flex-1 md:grid-cols-2 md:divide-x md:divide-border">
          <div className={cn("flex min-h-0 flex-col", m.issue && "hidden md:flex")}>
            <LinearList
              busy={m.busy}
              cursor={m.cursor}
              emptyLabel={t("empty")}
              issues={visible}
              moreLabel={t("more")}
              onMore={() => void m.run(() => m.refresh(m.cursor ?? undefined))}
              onSelect={(id) => void m.selectIssue(id)}
              selectedId={m.issue?.id}
              t={t}
            />
          </div>
          <div className="flex min-h-0 flex-col">
            {m.issue ? (
              <LinearDetail
                busy={m.busy}
                issue={m.issue}
                onBack={m.closeIssue}
                onComment={m.comment}
                onStateChange={(state) => void m.update(state.id)}
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
