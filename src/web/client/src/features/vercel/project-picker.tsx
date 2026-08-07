import { useEffect, useState } from "react";
import { listVercelProjects, setVercelProject, type VercelProject } from "@/lib/api";
import { LinkIcon } from "./vercel-icons";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/loading";
import { useT } from "@/lib/i18n";
import { TeamSwitcher } from "./team-switcher";
import { VercelLogo } from "./vercel-logo";

/**
 * Shown when Vercel is connected but no project resolves for this repository.
 *
 * The server already tried `.vercel/project.json` and the git remote, so
 * reaching here means neither answered — this is the manual pin, not a
 * duplicate of auto-detection.
 */
export function ProjectPicker({
  repositoryName,
  onLinked,
}: {
  repositoryName?: string;
  onLinked: () => void;
}) {
  const t = useT();
  const [projects, setProjects] = useState<VercelProject[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listVercelProjects()
      .then((res) => {
        if (active) setProjects(res.projects);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function link(projectId: string) {
    setLinking(projectId);
    setError(null);
    try {
      await setVercelProject(projectId);
      onLinked();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLinking(null);
    }
  }

  const term = search.trim().toLowerCase();
  const visible = term
    ? projects.filter((project) => project.name.toLowerCase().includes(term))
    : projects;

  return (
    <div className="mx-auto flex h-full w-full max-w-lg flex-col gap-3 p-6">
      <div className="flex items-start gap-2">
        <VercelLogo className="mt-0.5 size-4" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t("vercel.link.title")}</h2>
          <p className="text-[12px] text-muted-foreground">
            {repositoryName
              ? t("vercel.link.descFor").replace("{repo}", repositoryName)
              : t("vercel.link.desc")}
          </p>
        </div>
        {/* An empty list here is far more often the wrong scope than an empty
            account, so the switcher belongs next to the list, not in settings. */}
        <TeamSwitcher />
      </div>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <Input
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t("vercel.link.search")}
        value={search}
      />

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
        {loading ? (
          <Loading fill label={t("common.loading")} />
        ) : visible.length === 0 ? (
          <p className="p-4 text-[12px] text-muted-foreground">{t("vercel.link.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((project) => (
              <li className="flex items-center gap-2 px-3 py-2" key={project.id}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{project.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {[project.framework, project.link?.repo].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <Button
                  loading={linking === project.id}
                  onClick={() => void link(project.id)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <LinkIcon />
                  {t("vercel.link.action")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
