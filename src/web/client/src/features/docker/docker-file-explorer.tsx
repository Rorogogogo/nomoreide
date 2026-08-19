import { useCallback } from "react";
import {
  getDockerContainerDirectory,
  getDockerContainerFile,
  type DockerContainerSummary,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ReadOnlyFileExplorer } from "../servers/remote-file-explorer";

export function DockerFileExplorer({
  container,
  onBack,
}: {
  container: DockerContainerSummary;
  onBack: () => void;
}) {
  const t = useT();
  const readDirectory = useCallback(
    (path: string, includeHidden: boolean) =>
      getDockerContainerDirectory(container.id, path, includeHidden),
    [container.id],
  );
  const readFile = useCallback(
    (path: string) => getDockerContainerFile(container.id, path),
    [container.id],
  );

  return (
    <ReadOnlyFileExplorer
      backLabel={t("docker.files.back")}
      label={container.name}
      onBack={onBack}
      readDirectory={readDirectory}
      readFile={readFile}
      title={t("docker.files.title")}
    />
  );
}
