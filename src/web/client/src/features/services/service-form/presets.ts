export type ServiceKindOption = "local" | "docker-compose" | "ssh";

export const serviceCommandPresets = [
  {
    label: "npm",
    command: "npm run dev",
    description: "Node dev server",
  },
  {
    label: "pnpm",
    command: "pnpm dev",
    description: "pnpm dev server",
  },
  {
    label: "yarn",
    command: "yarn dev",
    description: "Yarn dev server",
  },
  {
    label: "bun",
    command: "bun dev",
    description: "Bun dev server",
  },
  {
    label: "Deno",
    command: "deno task dev",
    description: "Deno dev task",
  },
  {
    label: "Vite",
    badgeCommand: "vite",
    command: "npm run dev -- --host 127.0.0.1",
    description: "Vite app",
  },
  {
    label: "Go",
    command: "go run .",
    description: "Go app",
  },
  {
    label: "Rust",
    command: "cargo run",
    description: "Rust app",
  },
  {
    label: ".NET",
    command: "dotnet watch run",
    description: ".NET app",
  },
  {
    label: "Python",
    command: "python manage.py runserver",
    description: "Python app",
  },
  {
    label: "Docker",
    command: "docker compose up",
    description: "Docker Compose stack",
  },
];

export const kindOptions: { value: ServiceKindOption; label: string; hint: string }[] = [
  { value: "local", label: "Local", hint: "Run a command in a local working directory." },
  {
    value: "docker-compose",
    label: "Docker Compose",
    hint: "Bring up a service defined in a docker-compose.yml file.",
  },
  {
    value: "ssh",
    label: "SSH (remote)",
    hint: "Run a command on a remote host using your local ~/.ssh/config + ssh-agent.",
  },
];
