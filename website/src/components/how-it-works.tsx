type Step = { n: string; title: string; body: string; code?: string };

const STEPS: Step[] = [
  {
    n: "01",
    title: "Install",
    body: "One command. No daemons, no signup, no config.",
    code: "npm i -g nomoreide",
  },
  {
    n: "02",
    title: "Launch",
    body: "Drop into your repo and start the workbench. It auto-detects your services and Git state.",
    code: "nomoreide",
  },
  {
    n: "03",
    title: "Work",
    body: "Run services, review diffs, tail logs, and chain MCP workflows — all from one place.",
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
            From npm to flow in 30 seconds
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
                    <span className="text-muted-foreground">$ </span>
                    {s.code}
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
