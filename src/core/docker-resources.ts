/**
 * The non-container half of a Docker host: images, volumes, and networks.
 * Read-only by design — pruning and removal are destructive and belong behind
 * an explicit guard, mirroring the git-manager / git-actions split.
 */
import { execDocker, parseDockerJsonLines, readString } from "./docker.js";

export interface DockerImageSummary {
  id: string;
  repository: string;
  tag: string;
  /** Human size string straight from Docker, e.g. "417MB". */
  size: string;
  createdSince: string;
  /** True for untagged layers left behind by rebuilds (`<none>:<none>`). */
  dangling: boolean;
}

export async function listDockerImages(): Promise<DockerImageSummary[]> {
  return parseDockerImageLines(await execDocker(["images", "--format", "{{json .}}"]));
}

export function parseDockerImageLines(stdout: string): DockerImageSummary[] {
  return parseDockerJsonLines(stdout, (raw) => {
    const id = readString(raw, "ID");
    if (!id) return null;
    const repository = readString(raw, "Repository");
    const tag = readString(raw, "Tag");
    return {
      id,
      repository,
      tag,
      size: readString(raw, "Size"),
      createdSince: readString(raw, "CreatedSince"),
      dangling: repository === "<none>" || tag === "<none>",
    };
  });
}

export interface DockerVolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
}

export async function listDockerVolumes(): Promise<DockerVolumeSummary[]> {
  return parseDockerVolumeLines(await execDocker(["volume", "ls", "--format", "{{json .}}"]));
}

export function parseDockerVolumeLines(stdout: string): DockerVolumeSummary[] {
  return parseDockerJsonLines(stdout, (raw) => {
    const name = readString(raw, "Name");
    if (!name) return null;
    return {
      name,
      driver: readString(raw, "Driver"),
      mountpoint: readString(raw, "Mountpoint"),
      scope: readString(raw, "Scope"),
    };
  });
}

export interface DockerNetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope: string;
}

export async function listDockerNetworks(): Promise<DockerNetworkSummary[]> {
  return parseDockerNetworkLines(await execDocker(["network", "ls", "--format", "{{json .}}"]));
}

export function parseDockerNetworkLines(stdout: string): DockerNetworkSummary[] {
  return parseDockerJsonLines(stdout, (raw) => {
    const id = readString(raw, "ID");
    if (!id) return null;
    return {
      id,
      name: readString(raw, "Name"),
      driver: readString(raw, "Driver"),
      scope: readString(raw, "Scope"),
    };
  });
}
