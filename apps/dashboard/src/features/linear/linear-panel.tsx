import { useState, type ReactNode } from "react";
import type { LinearIssue, LinearTransport } from "./linear-types";
import { useLinearTasks } from "./use-linear-tasks";

export function LinearPanel({ send, t, taskAction }: { send: LinearTransport; t: (key: string) => string; taskAction?: (issue: LinearIssue) => ReactNode }) {
  const m = useLinearTasks(send);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [comment, setComment] = useState("");
  const selected = m.teams.find((team) => team.id === m.team);
  const control = "rounded border border-border bg-background px-2 py-2 text-sm disabled:opacity-50";
  return <section className="flex h-full min-h-0 flex-col text-sm">
    <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
      <select aria-label={t("team")} className={control} value={m.team} disabled={m.busy} onChange={(e) => { m.selectTeam(e.target.value); setStatus(""); }}>
        <option value="">{t("team")}</option>{m.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
      </select>
      <select aria-label={t("project")} className={control} value={m.project} disabled={m.busy} onChange={(e) => m.setProject(e.target.value)}>
        <option value="">{t("allProjects")}</option>{selected?.projects.nodes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button type="button" className={control} disabled={!m.team || m.busy} onClick={() => void m.link()}>{t("link")}</button>
      <button type="button" className={control} disabled={!m.team || m.busy} onClick={() => void m.run(() => m.refresh())}>{t("refresh")}</button>
    </div>
    {m.error && <div className="p-3"><p role="alert" className="text-red-600">{m.error}</p>{!m.teams.length && <button type="button" className={control} disabled={m.busy} onClick={() => void m.reloadMetadata()}>{t("refresh")}</button>}</div>}
    {m.busy && <p role="status" className="px-3">{t("loading")}</p>}
    <div className="grid min-h-0 flex-1 overflow-auto md:grid-cols-2">
      <div className={`space-y-2 border-b border-border p-3 md:overflow-auto md:border-b-0 md:border-r ${m.issue ? "hidden md:block" : ""}`}>
        <input aria-label={t("search")} placeholder={t("search")} className={`${control} w-full`} value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label={t("status")} className={control} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t("allStatuses")}</option>{selected?.states.nodes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select aria-label={t("priority")} className={control} value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">{t("allPriorities")}</option>{[0, 1, 2, 3, 4].map((p) => <option key={p} value={p}>{t(`priority${p}`)}</option>)}</select>
        {!m.issues.length && <p className="py-4 text-muted-foreground">{t("empty")}</p>}
        {m.issues.filter((i) => (!status || i.state.id === status) && (!priority || i.priority === Number(priority)) && `${i.identifier} ${i.title} ${i.assignee?.name ?? ""}`.toLowerCase().includes(search.toLowerCase())).map((i) => <button type="button" key={i.id} disabled={m.busy} onClick={() => { setComment(""); void m.selectIssue(i.id); }} className={`block w-full border-b border-border p-3 text-left hover:bg-muted/20 ${m.issue?.id === i.id ? "bg-muted/45" : ""}`}><span className="text-xs text-muted-foreground">{i.identifier} · {i.state.name} · {i.assignee?.name}</span><span className="block">{i.title}</span></button>)}
        {m.cursor && <button type="button" className={control} disabled={m.busy} onClick={() => void m.run(() => m.refresh(m.cursor ?? undefined))}>{t("more")}</button>}
        <form className="space-y-2 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); void m.create(title, description).then((saved) => { if (saved) { setTitle(""); setDescription(""); } }); }}>
          <input className={`${control} w-full`} aria-label={t("title")} placeholder={t("title")} required maxLength={512} value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className={`${control} w-full`} aria-label={t("description")} placeholder={t("description")} maxLength={16000} value={description} onChange={(e) => setDescription(e.target.value)} />
          <button type="submit" className={control} disabled={!m.team || !title.trim() || m.busy}>{t("create")}</button>
        </form>
      </div>
      <div className="space-y-3 p-3 md:overflow-auto">
        {m.issue ? <>
          <button type="button" className={`${control} md:hidden`} onClick={m.closeIssue}>{t("back")}</button>
          <h2 className="font-semibold">{m.issue.identifier} · {m.issue.title}</h2>
          <a className="underline" href={m.issue.url.startsWith("https://linear.app/") ? m.issue.url : undefined} target="_blank" rel="noreferrer">{t("open")}</a>
          {taskAction?.(m.issue)}
          <p className="whitespace-pre-wrap break-words">{m.issue.description}</p>
          <select aria-label={t("status")} className={control} disabled={m.busy} value={m.issue.state.id} onChange={(e) => void m.update(e.target.value)}>{m.teams.find((v) => v.id === m.issue?.team.id)?.states.nodes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          {m.issue.comments?.nodes.map((c) => <div key={c.id} className="border-t border-border pt-2"><span className="text-xs text-muted-foreground">{c.user?.name}</span><p className="whitespace-pre-wrap break-words">{c.body}</p></div>)}
          {m.issue.comments?.pageInfo.hasNextPage && <p>{t("moreComments")}</p>}
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void m.comment(comment).then((saved) => { if (saved) setComment(""); }); }}><textarea aria-label={t("comment")} placeholder={t("comment")} className={`${control} w-full`} required maxLength={16000} value={comment} onChange={(e) => setComment(e.target.value)} /><button type="submit" className={control} disabled={!comment.trim() || m.busy}>{t("send")}</button></form>
        </> : <p className="text-muted-foreground">{t("select")}</p>}
      </div>
    </div>
  </section>;
}
