import type { TranslationKey } from "@/lib/i18n/en";

export type ServiceKindOption = "local" | "docker-compose" | "ssh";

// Tool `label`s (npm, Go, Rust, …) and `command`s are proper nouns / shell
// snippets and stay English; only the human-readable `descKey` is translated
// (resolved with `t()` where the preset is applied to the description field).
export const serviceCommandPresets: {
  label: string;
  command: string;
  description: TranslationKey;
  badgeCommand?: string;
}[] = [
  {
    label: "npm",
    command: "npm run dev",
    description: "services.preset.npm",
  },
  {
    label: "pnpm",
    command: "pnpm dev",
    description: "services.preset.pnpm",
  },
  {
    label: "yarn",
    command: "yarn dev",
    description: "services.preset.yarn",
  },
  {
    label: "bun",
    command: "bun dev",
    description: "services.preset.bun",
  },
  {
    label: "Deno",
    command: "deno task dev",
    description: "services.preset.deno",
  },
  {
    label: "Vite",
    badgeCommand: "vite",
    command: "npm run dev -- --host 127.0.0.1",
    description: "services.preset.vite",
  },
  {
    label: "Go",
    command: "go run .",
    description: "services.preset.go",
  },
  {
    label: "Rust",
    command: "cargo run",
    description: "services.preset.rust",
  },
  {
    label: ".NET",
    command: "dotnet watch run",
    description: "services.preset.dotnet",
  },
  {
    label: "Python",
    command: "python manage.py runserver",
    description: "services.preset.python",
  },
  {
    label: "Docker",
    command: "docker compose up",
    description: "services.preset.docker",
  },
];

export const kindOptions: {
  value: ServiceKindOption;
  label: TranslationKey;
  hint: TranslationKey;
}[] = [
  { value: "local", label: "services.kind.local", hint: "services.kind.localHint" },
  {
    value: "docker-compose",
    label: "services.kind.dockerCompose",
    hint: "services.kind.dockerComposeHint",
  },
  {
    value: "ssh",
    label: "services.kind.ssh",
    hint: "services.kind.sshHint",
  },
];
