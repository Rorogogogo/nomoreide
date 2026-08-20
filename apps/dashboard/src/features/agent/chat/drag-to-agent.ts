import type { DragEvent } from "react";

/**
 * Contract for dragging an in-app file/folder/service into the agent dock.
 *
 * The browser never exposes a real filesystem path for OS-native (Finder)
 * drags, so this only works for drags that *originate inside* NoMoreIDE —
 * where we already know each item's absolute path (git repo root + relative
 * path, or a service's cwd). The source sets the path on this custom MIME
 * type; the dock reads it on drop and inserts it into the draft.
 *
 * Drags may carry other MIME types alongside this one (e.g. a service row also
 * carries SERVICE_DRAG_TYPE for group drop zones), so each drop target keys off
 * its own type and they never collide.
 */
export const AGENT_PATH_MIME = "application/x-nomoreide-path";

/** Join an absolute repo/workspace root with a relative path into one path. */
export function absolutePath(root: string, relative: string): string {
  return `${root.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

/** Stamp the agent-path payload onto a drag (additive — keeps existing data). */
export function setAgentPathData(dataTransfer: DataTransfer, path: string): void {
  dataTransfer.setData(AGENT_PATH_MIME, path);
}

/** True when a drag carries an agent path (safe to call during dragover). */
export function hasAgentPath(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(AGENT_PATH_MIME);
}

/** Read the dropped agent path, or null when the drag carries none. */
export function readAgentPath(dataTransfer: DataTransfer): string | null {
  return dataTransfer.getData(AGENT_PATH_MIME) || null;
}

/**
 * Props that make an element draggable into the dock with the given absolute
 * path. Spread onto sources that have no drag of their own (git file rows).
 * Sources with an existing drag should call {@link setAgentPathData} instead.
 */
export function agentPathDragProps(path: string): {
  draggable: true;
  onDragStart: (event: DragEvent) => void;
} {
  return {
    draggable: true,
    onDragStart: (event) => {
      setAgentPathData(event.dataTransfer, path);
      event.dataTransfer.effectAllowed = "copy";
    },
  };
}
