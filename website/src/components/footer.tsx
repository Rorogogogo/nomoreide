export function Footer() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-muted-foreground md:flex-row">
        <p>
          <span className="font-semibold text-foreground">nomoreide</span> · MIT
          licensed
        </p>
        <nav className="flex items-center gap-6">
          <a
            href="https://github.com/Rorogogogo/nomoreide"
            className="transition hover:text-foreground"
          >
            GitHub
          </a>
          <a
            href="https://github.com/Rorogogogo/nomoreide#connect-your-ai-agent"
            className="transition hover:text-foreground"
          >
            MCP setup
          </a>
          <a
            href="https://github.com/Rorogogogo/nomoreide/issues"
            className="transition hover:text-foreground"
          >
            Issues
          </a>
        </nav>
      </div>
    </footer>
  );
}
