import { useCallback, useEffect, useRef, useState } from "react";
import type { LinearIssue, LinearTeam, LinearTransport } from "./linear-types";

export function useLinearTasks(send: LinearTransport) {
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [team, setTeam] = useState("");
  const [project, setProject] = useState("");
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [issue, setIssue] = useState<LinearIssue | null>(null);
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
      setTeams(data.teams?.nodes ?? []);
      setTeam(data.binding?.team ?? ""); setProject(data.binding?.project ?? "");
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
  return { teams, team, project, issues, issue, cursor, error, busy, run, refresh,
    reloadMetadata: () => run(async () => { const data = await send({ operation: "metadata" }); setTeams(data.teams?.nodes ?? []); setTeam(data.binding?.team ?? ""); setProject(data.binding?.project ?? ""); }),
    closeIssue: () => setIssue(null),
    selectTeam(value: string) { setTeam(value); setProject(""); }, setProject,
    selectIssue: (id: string) => run(async () => { const revision = generation.current; const data = await send({ operation: "issue", id }); if (revision === generation.current) setIssue(data.issue ?? null); }),
    link: () => run(async () => { await send({ operation: "binding", team, project: project || null }); }),
    create: (title: string, description: string) => run(async () => { const data = await send({ operation: "create", team, project: project || null, title, description }); await refresh(); setIssue(data.issueCreate?.issue ?? null); }),
    update: (state: string) => run(async () => { if (!issue) return; await send({ operation: "update", id: issue.id, state }); const data = await send({ operation: "issue", id: issue.id }); setIssue(data.issue ?? null); await refresh(); }),
    comment: (body: string) => run(async () => { if (!issue) return; await send({ operation: "comment", id: issue.id, body }); const data = await send({ operation: "issue", id: issue.id }); setIssue(data.issue ?? null); }),
  };
}
