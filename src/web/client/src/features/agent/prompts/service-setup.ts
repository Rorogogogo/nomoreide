/**
 * Handed to the dock agent when the user clicks "Set up with AI" on a service.
 * It drives the registration conversationally — one question at a time, like
 * Claude Code — detecting the start command itself and registering via the
 * nomoreide CLI.
 */
export const SETUP_SERVICE_PROMPT = [
  "I want to add a new service to NoMoreIDE. Walk me through it one step at a time —",
  "ask a single question per message and give me options to choose from where it helps.",
  "",
  "Whenever you offer me a set of choices, end that message with a fenced block",
  "labelled `options`, one choice per line, so I can click them. For example:",
  "```options",
  "Local",
  "Docker Compose",
  "SSH (remote)",
  "```",
  "",
  "When the answer is free text (not a pick-list), always show a concrete example",
  "in the question so I know the format — e.g. ask for the SSH host as",
  '\'What SSH host alias should I use? (for example: `devbox`)\', the command as',
  "'(for example: `npm run dev`)', the directory as '(for example: `/srv/app`)',",
  "and the name as '(for example: `backend`)'. Never ask for a value without an example.",
  "",
  "1. First ask whether it's local, a Docker Compose service, or remote over SSH.",
  "2. For local or Docker: ask which folder it lives in — and remind me I can click",
  "   the paperclip (attach) button at the bottom-left of this chat to browse and",
  "   insert the folder path. Then look inside it (package.json scripts,",
  "   docker-compose.yml, go.mod, etc.) and propose the start command and port —",
  "   confirm with me, don't assume.",
  "   For SSH: ask for the host alias, the remote command, and the remote directory.",
  "3. Confirm a short name for it.",
  "",
  "Once I've confirmed everything, register it by running the nomoreide CLI:",
  '  nomoreide add service <name> --command "<cmd>" --cwd "<dir>" [--port <n>] [--description "<text>"]',
  "  Docker: --kind docker-compose --compose-service <svc> [--compose-file <file>] --cwd <dir>",
  '  SSH:    --kind ssh --host <alias> --command "<cmd>" --cwd "<remote dir>"',
  "After it registers successfully, end your final message with the service name in a",
  "fenced `service` block so I get Start / Open buttons for it, e.g.:",
  "```service",
  "backend",
  "```",
].join("\n");
