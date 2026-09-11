import { useCallback, useEffect, useRef, useState } from "react";
import type { LinearData, LinearIssue, LinearState, LinearTeam, LinearTransport } from "./linear-types";

type LinearBinding = NonNullable<LinearData["binding"]> | null;

export function useLinearTasks(send: LinearTransport) {
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [team, setTeam] = useState("");
  const [project, setProject] = useState("");
  /** What this repository currently defaults to, and the repository's name. */
  const [binding, setBinding] = useState<LinearBinding>(null);
  const [repository, setRepository] = useState<string | null>(null);
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  /**
   * The current list, readable from a callback that must not re-create itself
   * every time the list changes — `moveIssue` needs the pre-drag order to
   * restore, and closing over `issues` would rebuild every mutation on every
   * keystroke of a paged fetch.
   */
  const issuesRef = useRef<LinearIssue[]>([]);
  issuesRef.current = issues;
  const [issue, setIssue] = useState<LinearIssue | null>(null);
  /** A full issue is in flight for the open task — only comments are missing. */
  const [detailPending, setDetailPending] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const operation = useRef(false);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const run = useCallback(async (work: () => Promise<void>) => {
    if (operation.current) return false;
    operation.current = true;
    setBusy(true); setError("");
    try { await work(); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { operation.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    let active = true;
    void send({ operation: "metadata" }).then((data) => {
      if (!active) return;
      const found = data.teams?.nodes ?? [];
      setTeams(found);
      setBinding(data.binding ?? null);
      setRepository(data.repository ?? null);
      setTeam(defaultTeam(found, data.binding?.team ?? null));
      setProject(data.binding?.project ?? "");
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; invalidate(); };
  }, [send, invalidate]);
  const refresh = useCallback(async (after?: string) => {
    if (!team) return;
    const revision = ++generation.current;
    const data = await send({ operation: "issues", team, project: project || null, after });
    if (revision !== generation.current) return;
    setIssues((old) => after ? [...old, ...(data.issues?.nodes ?? []).filter((item) => !old.some((v) => v.id === item.id))] : data.issues?.nodes ?? []);
    setCursor(data.issues?.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null);
  }, [send, team, project]);
  useEffect(() => {
    setIssues([]); setIssue(null); setCursor(null);
    void refresh().catch((e: Error) => setError(e.message));
    return invalidate;
  }, [refresh, invalidate]);
  // Whether the current selection *is* this repository's default. Compared on
  // both halves: the binding stores a team and a project, so a bound team seen
  // under a different project is not the thing that was saved.
  const bound =
    binding !== null && binding.team === team && (binding.project ?? "") === project;
  return { teams, team, project, issues, issue, cursor, error, busy, run, refresh,
    binding, repository, bound, detailPending,
    reloadMetadata: () => run(async () => { const data = await send({ operation: "metadata" }); const found = data.teams?.nodes ?? []; setTeams(found); setBinding(data.binding ?? null); setRepository(data.repository ?? null); setTeam(defaultTeam(found, data.binding?.team ?? null)); setProject(data.binding?.project ?? ""); }),
    closeIssue: () => { setIssue(null); setDetailPending(false); },
    selectTeam(value: string) { rememberTeam(value); setTeam(value); setProject(""); }, setProject,
    /**
     * Open a task.
     *
     * **The pane opens on the click, not on the answer.** Every field it shows
     * except the comments is already in the row that was clicked — the list
     * query fetches the same fragment — so waiting for a round trip before
     * rendering anything left the click with no feedback at all, and on a slow
     * network read as a dead row. The known issue goes in immediately and the
     * fetch that follows only adds the comments, which is the one thing it
     * actually brings.
     */
    selectIssue: (id: string) => {
      const known = issuesRef.current.find((entry) => entry.id === id) ?? null;
      if (known) setIssue(known);
      setDetailPending(true);
      const revision = generation.current;
      return run(async () => {
        const data = await send({ operation: "issue", id });
        if (revision === generation.current) setIssue(data.issue ?? known);
      }).finally(() => setDetailPending(false));
    },
    /**
     * Make the current team and project this repository's default, or clear it
     * — one toggle, because the control is a checkbox rather than a verb. The
     * answer is applied rather than re-fetched: the daemon has just written it,
     * and a metadata round trip would reset the pickers mid-interaction.
     */
    toggleBinding: () => run(async () => {
      if (bound) {
        await send({ operation: "unbind" });
        setBinding(null);
        return;
      }
      const next = { team, project: project || null };
      await send({ operation: "binding", ...next });
      setBinding(next);
    }),
    /**
     * A new Linear project in the current team, then selected.
     *
     * The team list is reloaded rather than patched locally: projects hang off
     * the team in `metadata`, and inventing the new one client-side would leave
     * the picker holding a project the next reload might disagree about.
     */
    createProject: (name: string, description: string) => run(async () => {
      const data = await send({ operation: "createProject", team, name, description });
      const created = data.projectCreate?.project ?? null;
      const refreshed = await send({ operation: "metadata" });
      setTeams(refreshed.teams?.nodes ?? []);
      if (created) setProject(created.id);
    }),
    create: (title: string, description: string) => run(async () => { const data = await send({ operation: "create", team, project: project || null, title, description }); await refresh(); setIssue(data.issueCreate?.issue ?? null); }),
    update: (state: string) => run(async () => { if (!issue) return; await send({ operation: "update", id: issue.id, state }); const data = await send({ operation: "issue", id: issue.id }); setIssue(data.issue ?? null); await refresh(); }),
    /**
     * Place any issue: its column and its position in that column — what a
     * board drop calls.
     *
     * Optimistic, and deliberately so: a drag that snaps back for the length of
     * a round trip reads as a rejected drop. The card moves on release, and the
     * server's answer either confirms it or puts it back with the error shown.
     *
     * `run` guards against a second mutation while one is in flight, so a fast
     * second drag is refused rather than racing the first — a board is one
     * person's screen, and two moves that interleave produce an order neither
     * of them asked for.
     */
    placeIssue: (id: string, state: LinearState, sortOrder: number) => run(async () => {
      const before = issuesRef.current;
      setIssues((current) =>
        current.map((item) => (item.id === id ? { ...item, state, sortOrder } : item)),
      );
      setIssue((current) => (current?.id === id ? { ...current, state, sortOrder } : current));
      try {
        await send({ operation: "place", id, state: state.id, sortOrder });
      } catch (failure) {
        // Put it back exactly where it was. Re-fetching instead would also
        // repair it, but a whole list reload on a failed drag loses the
        // scroll position and any newer page the user had already asked for.
        setIssues(before);
        throw failure;
      }
    }),
    comment: (body: string) => run(async () => { if (!issue) return; await send({ operation: "comment", id: issue.id, body }); const data = await send({ operation: "issue", id: issue.id }); setIssue(data.issue ?? null); }),
  };
}

/** Where the last chosen team is kept. Per-browser, and only ever a hint. */
const REMEMBERED_TEAM = "nomoreide.linear.team";
const REMEMBERED_VIEW = "nomoreide.linear.view";

/**
 * List or board, as last left — and **board when nothing has been chosen yet**.
 *
 * The view used to reset to the list on every mount, and the panel is remounted
 * whenever the selected repository changes, so choosing the board never
 * survived leaving the page. Kept beside the remembered team because it is the
 * same kind of thing: a per-browser convenience, not a statement about the
 * repository the way a binding is.
 */
export function rememberedView(): "list" | "board" {
  try {
    const stored = window.localStorage.getItem(REMEMBERED_VIEW);
    if (stored === "list" || stored === "board") return stored;
  } catch {
    // Storage can be unavailable; the default is not worth an error.
  }
  return "board";
}

export function rememberView(view: "list" | "board") {
  try {
    window.localStorage.setItem(REMEMBERED_VIEW, view);
  } catch {
    // As above — a forgotten preference is not a failure worth showing.
  }
}

function rememberTeam(id: string) {
  try {
    if (id) window.localStorage.setItem(REMEMBERED_TEAM, id);
    else window.localStorage.removeItem(REMEMBERED_TEAM);
  } catch {
    // Storage can be unavailable (a private window, site data blocked). A
    // forgotten preference is not worth an error on a page load.
  }
}

/**
 * Which team to open on.
 *
 * The panel used to open on *no* team whenever the repository had no Linear
 * binding, which meant an empty list and a trip to the picker every single
 * time — including for a workspace that has exactly one team to choose.
 *
 * In order: the repository's binding, then the last team picked here, then
 * whatever the workspace listed first.
 *
 * **The binding is taken on trust and the remembered team is not**, which is
 * the one asymmetry worth stating. A binding is an explicit statement someone
 * made about this checkout and is stored beside it; validating it against the
 * team list would mean a metadata call that came back thin — no teams, a
 * partial answer — silently discarded that statement and reset the panel. The
 * remembered team is only a local convenience, so it has to name something
 * that actually exists or it is ignored.
 */
function defaultTeam(teams: LinearTeam[], bound: string | null): string {
  if (bound) return bound;
  let remembered: string | null = null;
  try {
    remembered = window.localStorage.getItem(REMEMBERED_TEAM);
  } catch {
    remembered = null;
  }
  if (remembered && teams.some((team) => team.id === remembered)) return remembered;
  return teams[0]?.id ?? "";
}
