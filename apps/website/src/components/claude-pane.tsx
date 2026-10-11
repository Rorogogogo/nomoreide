import { useState } from "react";
import { Check, Copy } from "lucide-react";

const INSTALL = "/plugin install nomoreide --marketplace Rorogogogo/nomoreide";

const INSIDE: { title: string; body: string }[] = [
  {
    title: "Git review",
    body: "Changes, diffs and history, with stage, commit, fetch and push. The branch's pull request and its Actions runs sit beside them.",
  },
  {
    title: "Services",
    body: "What is running, on which port, with live logs and CPU and memory. Open, restart or stop a service from its row.",
  },
  {
    title: "Errors",
    body: "Errors captured from your services, each with a press that drafts the fix as a prompt for Claude.",
  },
  {
    title: "Databases",
    body: "A read-only look into registered databases: browse tables, run a query, or ask Claude to write one.",
  },
  {
    title: "Files",
    body: "Browse the repository and edit a file in place, with Vim keys, without leaving the conversation.",
  },
  {
    title: "Console and Linear",
    body: "What the agent changed, its usage and installed tools, and your Linear tasks, in the same pane.",
  },
];

/**
 * The Claude Code pane, shown rather than described: the tour plays muted and
 * on a loop, so the section works without a click and never makes a sound the
 * visitor did not ask for. The controls are there for anyone who wants the
 * score, or wants to stop it.
 */
export function ClaudePane() {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(INSTALL).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <section id="claude-code" className="relative border-t border-border/60">
      <div className="mx-auto max-w-6xl px-6 py-24 md:py-32">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            New · Inside Claude Code
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">
            The workbench, beside the chat
          </h2>
          <p className="mt-4 text-muted-foreground md:text-lg">
            Type <code className="font-mono text-foreground">/nomoreide</code> and a pane opens next to your
            conversation: review diffs and history, watch services and logs, hand an error to Claude in one
            click, query a database, edit a file. In the desktop app and in the terminal.
          </p>
        </div>

        <video
          className="mt-12 aspect-video w-full rounded-xl border border-border bg-muted/40 shadow-2xl"
          src="/videos/claude-code-pane.mp4"
          poster="/videos/claude-code-pane.jpg"
          autoPlay
          muted
          loop
          playsInline
          controls
          preload="metadata"
          aria-label="A 40-second tour of the NoMoreIDE pane in Claude Code"
        />

        <div className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
          {INSIDE.map((item) => (
            <div key={item.title} className="bg-background p-6">
              <h3 className="text-base font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{item.body}</p>
            </div>
          ))}
        </div>

        <div className="mx-auto mt-10 max-w-2xl text-center">
          <p className="text-sm text-muted-foreground">
            The install script adds the pane when it finds Claude Code. To add it yourself, run this inside
            Claude Code (2.1.275 or later):
          </p>
          <div className="mt-4 flex items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-3 text-left">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs md:text-sm">
              {INSTALL}
            </code>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy the install command"
              className="shrink-0 text-muted-foreground transition hover:text-foreground"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
