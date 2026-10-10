import type { Database, DbRows, DbTables, LogLine, Pull, Repo, Service, Tool, ToolKind } from '../types'
import { isStaged } from './git'

// What the pane asks of Claude, in the dashboard's own words
// (apps/dashboard/src/features/agent/prompts). Every one is drafted into the
// prompt box, never sent: the person reads it, finishes it, and sends it.
// Anything that changes configuration, or needs judgement, goes this way
// rather than being done by the pane.

const MAX_LISTED = 40

const listed = (items: readonly string[]): string[] => [
  ...items.slice(0, MAX_LISTED).map(item => `- ${item}`),
  ...(items.length > MAX_LISTED ? [`- …and ${items.length - MAX_LISTED} more`] : []),
]

/** A commit message for what is staged; the commit itself stays a button. */
export function commitMessagePrompt(repo: Repo): string {
  return [
    'Write a concise Git commit message for my currently staged changes.',
    '',
    '- Inspect the staged diff yourself (`git diff --cached` or the `nomoreide_git_staged_diff` tool).',
    '- Use a conventional-commit style subject (≤ 72 chars), then a short body if it helps.',
    "- Reply with ONLY the commit message in a code block so I can copy it — don't commit it yourself.",
    '',
    `Repository: \`${repo.name}\`, branch: \`${repo.branch}\``,
    '',
    'Staged files:',
    ...listed(repo.files.filter(isStaged).map(file => file.path)),
  ].join('\n')
}

export function createPullPrompt(repo: Repo): string {
  return [
    `Open a pull request for the branch \`${repo.branch}\` of \`${repo.name}\`.`,
    '',
    '- Read the commits and the diff against the default branch first.',
    "- Follow the repository's pull request template if it has one.",
    '- Push the branch if it is not on the remote yet, then create the PR with `gh pr create` and give me the link.',
    '',
    'Anything to stress in the description: ',
  ].join('\n')
}

export function reviewPullPrompt(pull: Pull): string {
  return [
    `Pull request #${pull.number} — "${pull.title}":`,
    pull.url,
    '',
    `Pull the diff with \`gh pr diff ${pull.number}\` (or your GitHub tools), review it, and tell me what stands out.`,
    '',
    'Look especially at: ',
  ].join('\n')
}

/** A service's state and its latest output, with the ask to find what is wrong. */
export function debugServicePrompt(service: Service, lines: readonly LogLine[]): string {
  const standing = [
    `state: ${service.state}`,
    service.exitCode === null ? '' : `exit code: ${service.exitCode}`,
    service.port === null ? '' : `port: ${service.port}`,
    service.cwd === '' ? '' : `cwd: ${service.cwd}`,
  ].filter(part => part !== '')

  return [
    `Here's the current state of my \`${service.name}\` service. Take a look at it and its recent logs,`,
    "tell me what stands out, and help me fix anything that's wrong.",
    '',
    ...standing.map(part => `- ${part}`),
    '',
    'Recent output:',
    '```',
    ...(lines.length === 0 ? ['(none yet)'] : lines.slice(-40).map(line => line.text)),
    '```',
    '',
    'The NoMoreIDE tools (`nomoreide_service_context`, `nomoreide_read_logs`) have the rest.',
  ].join('\n')
}

export function addServicePrompt(workspace: string): string {
  return [
    `Register a service in NoMoreIDE for the project at \`${workspace}\`, so it can be started and watched from here.`,
    '',
    'Work out the right command, working directory and port from the project itself, register it with the',
    '`nomoreide_register_service` tool, start it, and confirm it is healthy.',
    '',
    'The service I want: ',
  ].join('\n')
}

export function tablePrompt(rows: DbRows, engine: string): string {
  return [
    `I'm looking at the table \`${rows.table}\` in my ${engine === '' ? '' : `${engine} `}database (connection "${rows.database}").`,
    '',
    ...(rows.columns.length > 0 ? ['Columns:', ...listed(rows.columns), ''] : []),
    'Sample its rows yourself with the database tools if you need them.',
    '',
    'My question: ',
  ].join('\n')
}

export function databasePrompt(database: Database): string {
  return [
    `I'm looking at my ${database.engine === '' ? '' : `${database.engine} `}database (connection "${database.name}").`,
    '',
    'Inspect its tables and columns yourself with the database tools if you need them.',
    '',
    'My question: ',
  ].join('\n')
}

/** A table by name alone, before any of it has been read. */
export function namedTablePrompt(database: string, engine: string, table: string): string {
  return [
    `I'm looking at the table \`${table}\` in my ${engine === '' ? '' : `${engine} `}database (connection "${database}").`,
    '',
    'Inspect its columns and sample its rows yourself with the database tools if you need them.',
    '',
    'My question: ',
  ].join('\n')
}

/** One row, as the pane shows it: every column beside its value. */
export function rowPrompt(rows: DbRows, engine: string, index: number): string {
  const cells = rows.rows[index] ?? []
  const from = rows.sql === '' ? `table \`${rows.table}\`` : 'the result of a query'

  return [
    `I'm looking at a row in my ${engine === '' ? '' : `${engine} `}database (connection "${rows.database}", ${from}).`,
    '',
    ...(rows.sql === '' ? [] : ['The query:', '```sql', rows.sql, '```', '']),
    'The row:',
    '```',
    ...rows.columns.map((name, column) => `${name}: ${cells[column] ?? ''}`),
    '```',
    '',
    'My question: ',
  ].join('\n')
}

/** A query to be written, not run: a locked connection is asked for reads only. */
export function queryPrompt(tables: DbTables, engine: string, isWritable: boolean): string {
  return [
    `Write one ${engine === '' ? '' : `${engine} `}SQL statement for the database connection "${tables.database}".`,
    '',
    ...(tables.tables.length > 0
      ? ['Tables in this database:', ...listed(tables.tables), "Inspect a table's columns with the database tools if you need its exact schema.", '']
      : ['Use the database tools to inspect the available tables and columns before writing the query.', '']),
    'Rules:',
    isWritable
      ? "- This connection is unlocked for writes, so INSERT/UPDATE/DELETE/DDL are allowed if that's what I ask for."
      : '- This connection is read-only. Return a SELECT (or other read) statement only — never a write.',
    '- Return exactly one statement, in a ```sql code fence, and explain it in a line.',
    '',
    'What it should do: ',
  ].join('\n')
}

export function createTaskPrompt(): string {
  return [
    'Create a Linear issue with the NoMoreIDE or Linear tools, in the team this repository is bound to.',
    'Give it a clear title, a short description of what done looks like, and tell me its identifier.',
    '',
    'The issue: ',
  ].join('\n')
}

const KIND: Record<ToolKind, { one: string; add: string }> = {
  skills: {
    one: 'skill',
    add: 'Scaffold it at `~/.claude/skills/<name>/SKILL.md` (user) or `.claude/skills/<name>/SKILL.md` (project) with valid frontmatter (`name`, `description`) and a short body, then confirm it is discovered. If what I give is a URL or a repo, fetch and adapt it.',
  },
  mcp: {
    one: 'MCP server',
    add: 'Set it up with `claude mcp add` (or by editing `~/.claude.json`), then verify it connects. Parse the name, the command or URL, and any env and args from what I give.',
  },
  plugins: {
    one: 'plugin',
    add: 'Use the `/plugin` command or `claude plugin install <name>@<marketplace>` (add the marketplace first if needed), then confirm its skills, commands and MCP servers are available.',
  },
  hooks: {
    one: 'hook',
    add: 'Configure it in `~/.claude/settings.json` (user) or `.claude/settings.json` (project). Pick the correct hook event, matcher, command and scope from what I ask, then confirm it is listed.',
  },
}

/** Adding is the person's sentence to finish: what to add comes last, where they type. */
export function addToolPrompt(kind: ToolKind): string {
  const { one, add } = KIND[kind]

  return [`Add a new ${one} for Claude Code.`, '', add, '', `The ${one} to add: `].join('\n')
}

const namedOf = (kind: ToolKind, tool: Tool): string => {
  const scope = tool.scope === '' ? '' : `${tool.scope} `
  if (kind === 'hooks') return `the ${scope}\`${tool.name}\` hook${tool.where === '' ? '' : ` in \`${tool.where}\``}`
  if (kind === 'skills') return `the ${scope}skill \`${tool.name}\`${tool.where === '' ? '' : ` (at \`${tool.where}\`)`}`
  if (kind === 'plugins') return `the plugin \`${tool.name}\`${tool.where === '' ? '' : ` (from \`${tool.where}\`)`}`

  return `the ${scope}MCP server \`${tool.name}\``
}

const REMOVE: Record<ToolKind, (tool: Tool) => string> = {
  skills: () => "Delete its directory and confirm it's no longer registered. Check nothing else references it first.",
  mcp: tool =>
    `Run \`claude mcp remove ${tool.name}\`${tool.scope === '' ? '' : ` (scope: ${tool.scope})`}. Then confirm it no longer appears in the server list.`,
  plugins: () =>
    'Use `claude plugin uninstall` or the `/plugin` command, then confirm its skills, commands and MCP servers are gone.',
  hooks: () =>
    'Several hooks can share an event: show me the ones for this event first, and remove only the one I confirm. Then check it no longer appears in the hooks list.',
}

export function removeToolPrompt(kind: ToolKind, tool: Tool): string {
  const named = namedOf(kind, tool)

  return [`Remove ${named}.`, '', REMOVE[kind](tool)].join('\n')
}

export function askToolPrompt(kind: ToolKind, tool: Tool): string {
  return [`I'm looking at ${namedOf(kind, tool)}.`, '', 'My question: '].join('\n')
}
