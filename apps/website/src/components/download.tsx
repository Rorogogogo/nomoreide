import { useEffect, useState } from "react";
import { Download as DownloadIcon, ShieldAlert } from "lucide-react";
import {
  findLatestMacosRelease,
  RELEASES_URL,
  type MacosRelease,
} from "../lib/latest-macos-release";
import { Button } from "./ui/button";

const TECH_STACK = ["Tauri", "React", "Rust"];

// The same Rust binary, four ways. `install.sh` is first because it is the
// only one that also registers the MCP server with every agent it finds, and
// the only one that needs neither Node nor a Rust toolchain.
const CLI_INSTALLS = [
  {
    id: "script",
    label: "Install script",
    hint: "macOS and Linux. Downloads a prebuilt binary, verifies its checksum, and sets up your agents.",
    command: "curl -fsSL https://www.nomoreide.com/install.sh | sh",
  },
  {
    id: "npm",
    label: "npm",
    hint: "Ships the same prebuilt binary — npm is only the delivery mechanism.",
    command: "npm install -g nomoreide",
  },
  {
    id: "cargo",
    label: "cargo",
    hint: "Builds from source from crates.io. Takes a few minutes.",
    command: "cargo install nomoreide",
  },
];

const OPEN_STEPS = [
  "Drag NoMoreIDE into your Applications folder and double-click it — macOS will say it can't be verified.",
  "Open System Settings → Privacy & Security.",
  'Scroll down to the Security section. You\'ll see "NoMoreIDE was blocked to protect your Mac" — click Open Anyway.',
  "Confirm once more with Touch ID or your password. After that it launches like any other app.",
];

export function Download() {
  const [release, setRelease] = useState<MacosRelease | null>(null);

  useEffect(() => {
    let active = true;
    void findLatestMacosRelease()
      .then((latest) => {
        if (active) setRelease(latest);
      })
      .catch(() => {
        // Keep the releases-page fallback when GitHub is unavailable or
        // rate-limits an unauthenticated browser request.
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="relative border-t border-border/60" id="download">
      <div className="relative mx-auto max-w-4xl px-6 py-24 text-center md:py-28">
        <div className="absolute inset-x-0 top-0 -z-10 h-full bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,hsl(var(--foreground)/0.06),transparent)]" />

        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Install
        </p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-5xl">
          One binary. No Node required.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-muted-foreground md:text-lg">
          The CLI, the TUI, the web dashboard and the MCP server are all the
          same Rust executable, with the dashboard compiled into it. Pick
          whichever way you prefer.
        </p>

        <div className="mx-auto mt-8 grid max-w-3xl gap-3 text-left">
          {CLI_INSTALLS.map((option) => (
            <div
              className="rounded-lg border border-border bg-background/60 p-4"
              key={option.id}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-semibold">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.hint}</span>
              </div>
              <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-xs">
                <code>
                  <span className="text-muted-foreground">$ </span>
                  {option.command}
                </code>
              </pre>
            </div>
          ))}
        </div>

        <p className="mx-auto mt-4 max-w-2xl text-xs text-muted-foreground">
          Prefer to grab an archive yourself? Every release publishes builds for
          macOS (Apple silicon and Intel) and Linux (x86_64 and arm64) with a
          single <code className="font-mono">SHA256SUMS</code>, on the{" "}
          <a className="underline hover:text-foreground" href={RELEASES_URL}>
            releases page
          </a>
          .
        </p>

        <div className="mt-16 border-t border-border/60 pt-16" />

        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Desktop app
        </p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-5xl">
          Prefer a real app? Get it for macOS.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-muted-foreground md:text-lg">
          The same workbench, packaged as a standalone native app — no Node
          install, no terminal. Built with Tauri: a Rust backend and the same
          React UI you see above.
        </p>

        <div className="mt-6 flex items-center justify-center gap-2">
          {TECH_STACK.map((tech) => (
            <span
              className="rounded-full border border-border bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground"
              key={tech}
            >
              {tech}
            </span>
          ))}
        </div>

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild size="lg">
            <a className="gap-2" href={release?.downloadUrl ?? RELEASES_URL}>
              <DownloadIcon className="size-4" />
              {release?.version
                ? `Download v${release.version} for macOS`
                : "Download for macOS"}
            </a>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href="https://github.com/Rorogogogo/nomoreide">View source on GitHub</a>
          </Button>
        </div>

        <div className="mx-auto mt-10 max-w-2xl rounded-lg border border-amber-500/30 bg-amber-500/5 p-5 text-left">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-4 shrink-0 text-amber-500" />
            <h3 className="text-sm font-semibold">
              First launch: macOS will block it (and that's expected)
            </h3>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            This is a free, open-source side project and I haven't paid for an
            Apple Developer account ($99/year), so the app isn't notarized by
            Apple. macOS plays it safe and blocks unsigned apps on first open.
            Here's the one-time fix:
          </p>
          <ol className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
            {OPEN_STEPS.map((step, index) => (
              <li className="flex gap-3" key={step}>
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-xs font-medium text-foreground">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">
            The code is fully open source if you'd rather read it first — or
            build it yourself with{" "}
            <code className="font-mono text-foreground">npm run tauri:build</code>.
          </p>
        </div>
      </div>
    </section>
  );
}
