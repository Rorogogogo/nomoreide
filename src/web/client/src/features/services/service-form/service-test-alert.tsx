import { Alert } from "@/components/ui/alert";
import type { ServiceTestResult } from "@/lib/api";

export function ServiceTestAlert({ result }: { result: ServiceTestResult }) {
  const output = [...result.stdout, ...result.stderr].slice(0, 4);

  return (
    <Alert variant={result.ok ? "default" : "destructive"}>
      <div className="font-medium">{result.ok ? "Command test passed" : "Command test failed"}</div>
      <div className="mt-1 text-xs">{result.message}</div>
      {output.length ? (
        <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-background/80 p-2 font-mono text-[11px] leading-4">
          {output.join("\n")}
        </pre>
      ) : null}
    </Alert>
  );
}
