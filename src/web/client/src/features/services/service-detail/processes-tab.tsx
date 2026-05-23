import type { ProcessRow } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ProcessesTab({ rows }: { rows: ProcessRow[] }) {
  if (rows.length === 0) {
    return <div className="text-muted-foreground">No process tree (service not running).</div>;
  }
  const sorted = [...rows].sort((a, b) => b.cpuPercent - a.cpuPercent);
  const pidSet = new Set(rows.map((row) => row.pid));
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-3">PID</th>
            <th className="py-1 pr-3">PPID</th>
            <th className="py-1 pr-3 text-right">CPU%</th>
            <th className="py-1 pr-3 text-right">RSS MB</th>
            <th className="py-1">Command</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const isChild = pidSet.has(row.ppid);
            return (
              <tr key={row.pid} className="border-t border-border/40">
                <td className="py-1 pr-3">{row.pid}</td>
                <td className="py-1 pr-3 text-muted-foreground">{row.ppid}</td>
                <td className="py-1 pr-3 text-right">{row.cpuPercent.toFixed(1)}</td>
                <td className="py-1 pr-3 text-right">{row.rssMb.toFixed(1)}</td>
                <td className={cn("py-1 truncate max-w-[60ch]", isChild && "pl-4")}>
                  {row.command}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
