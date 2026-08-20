type Step = { n: string; title: string; body: string; code?: string[] };

const STEPS: Step[] = [
  {
    n: "01",
    title: "Add the MCP server",
    body: "Register NoMoreIDE with your agent. It runs locally over stdio through npx, so there is no separate daemon or account.",
    code: [
      "claude mcp add --transport stdio nomoreide -- npx -y nomoreide",
      "codex mcp add nomoreide -- npx -y nomoreide",
      'Gemini: add {"command":"npx","args":["-y","nomoreide"]} to mcpServers.nomoreide',
    ],
  },
  {
    n: "02",
    title: "Verify the connection",
    body: "Restart your agent if needed, open the MCP panel, and confirm the nomoreide tools are available.",
    code: ["/mcp"],
  },
  {
    n: "03",
    title: "Open the Web UI and work",
    body: "Ask your agent to run services, review diffs, tail logs, and chain workflows through the NoMoreIDE MCP tools. The Web UI runs at http://127.0.0.1:4317/.",
  },
];

export function HowItWorks() {
  return (
    <section className="relative border-t border-border/60">
      <div className="mx-auto max-w-6xl px-6 py-24 md:py-32">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            How it works
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">
            From MCP setup to flow in 30 seconds
          </h2>
        </div>

        <ol className="mt-14 grid gap-6 md:grid-cols-3">
          {STEPS.map((s) => (
            <li
              key={s.n}
              className="relative rounded-xl border border-border bg-background p-6"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {s.n}
              </span>
              <h3 className="mt-2 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
              {s.code && (
                <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
                  <code>
                    {s.code.map((line) => (
                      <span key={line} className="block">
                        <span className="text-muted-foreground">$ </span>
                        {line}
                      </span>
                    ))}
                  </code>
                </pre>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
