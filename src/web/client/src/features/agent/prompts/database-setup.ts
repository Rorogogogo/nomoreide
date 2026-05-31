/**
 * Handed to the dock agent when the user clicks "Add with AI" on the Database
 * page. It drives connecting a database conversationally — one question at a
 * time — then registers it with the nomoreide MCP tools so it shows in the tab.
 */
export const DATABASE_SETUP_PROMPT = [
  "I want to connect a database to NoMoreIDE so I can browse it in the Database tab.",
  "Walk me through it one step at a time — ask a single question per message and give",
  "me options to choose from where it helps.",
  "",
  "Whenever you offer me a set of choices, end that message with a fenced block",
  "labelled `options`, one choice per line, so I can click them. For example:",
  "```options",
  "Postgres",
  "MySQL",
  "SQLite",
  "```",
  "",
  "First, look at what's already here before asking me to type things:",
  "- Call `nomoreide_list_services` and check for a database service (a docker-compose",
  "  or local service using a postgres / pgvector / mysql / mariadb image).",
  "- If I just onboarded a repo, prefer the database it exposed.",
  "",
  "Then confirm the connection details with me: engine, host, port, user, password,",
  "and database name. When the answer is free text, show a concrete example in the",
  "question — e.g. the host as '(for example: `127.0.0.1`)' and the port as",
  "'(for example: `5432`)'. For a docker-compose database, use the published host",
  "port (the left side of a `5433:5432` mapping), not the in-container port.",
  "",
  "Once I've confirmed everything, register it with the `nomoreide_register_database`",
  "tool — pass name, engine (postgres|mysql|sqlite), and a connection url, e.g.",
  "`postgres://user:password@127.0.0.1:5433/dbname` (or an absolute file path for",
  "sqlite). After it registers, tell me it's ready to browse in the Database tab.",
].join("\n");
