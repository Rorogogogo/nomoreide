import { useEffect, useState } from "react";
import { RefreshCw, ScrollText } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { getDockerContainerLogs, type DockerContainerSummary } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ComposerDialog } from "../services/service-form/composer-dialog";

export function DockerLogsDialog({
  container,
  onClose,
}: {
  container: DockerContainerSummary;
  onClose: () => void;
}) {
  const t = useT();
  const [logs, setLogs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setLogs(await getDockerContainerLogs(container.id, 500));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container.id]);

  return (
    <ComposerDialog
      icon={<ScrollText />}
      onClose={onClose}
      size="lg"
      title={t("docker.logs.title", { name: container.name })}
    >
      <div className="mb-2 flex justify-end">
        <Button
          disabled={loading}
          loading={loading}
          onClick={() => void load()}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw />
          {t("common.refresh")}
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">{error}</Alert>
      ) : loading && logs === null ? (
        <Loading className="py-10" label={t("docker.logs.loading")} />
      ) : logs ? (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-3 font-mono text-[11px]">
          {logs}
        </pre>
      ) : (
        <Alert variant="muted">{t("docker.logs.empty")}</Alert>
      )}
    </ComposerDialog>
  );
}
