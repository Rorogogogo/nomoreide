import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

export function MemoryTab({ agent }: { agent: AgentInfo }) {
  return (
    <Card className="min-w-0 rounded-none border-0 bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Brain className="size-4 text-muted-foreground" />
            <CardTitle>Project Memory</CardTitle>
          </div>
          <Badge variant="outline" size="small">
            {agent.project.memoryFiles.length + (agent.project.claudeMdPath ? 1 : 0)}
          </Badge>
        </div>
        <CardDescription className="truncate text-xs">
          {agent.project.memoryDir ?? "No memory directory found for this project."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 p-3">
        {agent.project.claudeMdPath ? (
          <CollapsibleFile
            title="CLAUDE.md"
            preview={agent.project.claudeMdPreview}
            defaultOpen={true}
          />
        ) : null}
        {agent.project.memoryFiles.length ? (
          agent.project.memoryFiles.map((file) => (
            <CollapsibleFile
              key={file.path}
              title={file.name}
              subtitle={`${file.size} B`}
              preview={file.preview}
              defaultOpen={file.name === "MEMORY.md"}
            />
          ))
        ) : !agent.project.claudeMdPath ? (
          <p className="text-xs text-muted-foreground">
            No memory files persisted yet for this project.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CollapsibleFile({
  title,
  subtitle,
  preview,
  defaultOpen = false,
}: {
  title: string;
  subtitle?: string;
  preview?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-border bg-background/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-semibold"
      >
        <ChevronRight
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span>{title}</span>
        {subtitle ? (
          <span className="font-mono text-[10px] font-normal text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </button>
      {open && preview ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {preview}
        </pre>
      ) : null}
    </div>
  );
}
