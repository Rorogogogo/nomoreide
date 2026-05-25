import {
  Database,
  File,
  FileCode2,
  FileText,
  FlaskConical,
  Image,
  LockKeyhole,
  Palette,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fileIconKind, type FileIconKind } from "./file-icon-kind";

/** Extension-aware file icon, shared by the git trees and the agent file picker. */
export function FileKindIcon({ path, className }: { path: string; className?: string }) {
  const kind = fileIconKind(path);
  const Icon = iconByKind[kind];
  return (
    <Icon aria-label={`${kind} file`} className={cn("size-3.5 shrink-0", iconClassByKind[kind], className)} />
  );
}

const iconByKind: Record<FileIconKind, LucideIcon> = {
  code: FileCode2,
  config: Settings2,
  data: Database,
  document: FileText,
  generic: File,
  image: Image,
  lock: LockKeyhole,
  style: Palette,
  test: FlaskConical,
};

const iconClassByKind: Record<FileIconKind, string> = {
  code: "text-sky-600",
  config: "text-zinc-600",
  data: "text-emerald-700",
  document: "text-blue-700",
  generic: "text-muted-foreground",
  image: "text-fuchsia-700",
  lock: "text-amber-700",
  style: "text-rose-700",
  test: "text-violet-700",
};
