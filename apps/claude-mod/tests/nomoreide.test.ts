import { expect, mock, test } from 'claude-code/testing'

import { endpointOf, toTools } from '../hooks/daemon'
import { ECHO_MS, isEcho, isFocusOnlyClick } from '../hooks/focus'
import { fitHunks, parsePull, parseStatus } from '../hooks/git'

const PANE = {
  plugin: 'nomoreide',
  component: 'Pane',
  requestId: 'nomoreide',
  props: {
    title: 'NoMoreIDE',
    isFocused: true,
    bodyColumns: 64,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** A `/nomoreide <view>` as the person types it into a fullscreen terminal. */
const typed = (args: string) =>
  ({
    command: 'nomoreide',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  }) as const

const STATUS = [
  '## main...origin/main [ahead 2, behind 1]',
  ' M src/app.ts',
  'A  docs/new.md',
  'R  src/next.ts',
  'src/old.ts',
  '?? notes.txt',
  '',
].join('\0')

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' const c = 4',
  '',
].join('\n')

test('git status is read: tracking, both sides, a rename and its source', () => {
  const status = parseStatus(STATUS)

  expect(status.branch).toBe('main')
  expect(status.upstream).toBe('origin/main')
  expect(status.ahead).toBe(2)
  expect(status.behind).toBe(1)
  expect(status.files).toEqual([
    { path: 'src/app.ts', index: ' ', workingTree: 'M' },
    { path: 'docs/new.md', index: 'A', workingTree: ' ' },
    { path: 'src/next.ts', index: 'R', workingTree: ' ' },
    { path: 'notes.txt', index: '?', workingTree: '?' },
  ])
  expect(parseStatus('## No commits yet on trunk\0').branch).toBe('trunk')
  expect(parseStatus('## HEAD (no branch)\0').branch).toBe('detached')
})

test('a diff is cut to its hunks, and a cut hunk still parses', () => {
  expect(fitHunks(DIFF)).toEqual({
    hunks: '@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 3\n const c = 4',
    hiddenLines: 0,
  })
  // Room for the header and two lines: the counts say what is left.
  expect(fitHunks(DIFF, 3)).toEqual({
    hunks: '@@ -1,2 +1,1 @@\n const a = 1\n-const b = 2',
    hiddenLines: 2,
  })
  expect(fitHunks('Binary files a/x.png and b/x.png differ\n').hunks).toBe('')
})

test('the daemon credential goes to loopback and nowhere else', () => {
  const credential = 'ab'.repeat(32)

  expect(endpointOf('{"url":"http://127.0.0.1:4317/"}', `${credential}\n`)).toEqual({
    url: 'http://127.0.0.1:4317',
    credential,
  })
  expect(endpointOf('{"url":"http://example.com:4317"}', credential)).toBeUndefined()
  expect(endpointOf('{"url":"http://127.0.0.1:4317"}', 'short')).toBeUndefined()
  expect(endpointOf('not json', credential)).toBeUndefined()
})

test('the pane lists what changed, stages a file and shows its diff', async ($, on) => {
  const ran: string[][] = []
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/work/app' }))
  on('config.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  // No daemon on this machine: the Git tab stands on git alone.
  on('fs.read', () => ({ deny: 'no such file' }))
  on('process.run', (_$, e) => {
    const args = e.argv.filter(arg => arg !== '--no-optional-locks').slice(1)
    ran.push(args)
    const stdout =
      args[0] === 'rev-parse' ? '/work/app\n' : args[0] === 'status' ? STATUS : args[0] === 'diff' ? DIFF : ''

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  await $.command.run(typed('git'))
  await clock.advance(3_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: 'main' }), 'the branch').toBeDefined()
    expect(await ui.find({ key: 'open:w:src/app.ts' }), 'a changed row').toBeDefined()
    expect(await ui.find({ key: 'open:s:docs/new.md' }), 'a staged row').toBeDefined()

    await ui.press({ key: 'move:w:notes.txt' })
    expect(ran).toContainEqual(['add', '--', 'notes.txt'])

    await ui.press({ key: 'open:w:src/app.ts' })
    expect(await ui.find({ type: 'Code' }), 'the diff').toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()

    await ui.unmount()
  }
})

test('with no daemon the other tabs say so and draw nothing else', async ($, on) => {
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/work/app' }))
  on('config.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({
    value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.command.run(typed('services'))
  await clock.advance(5_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /NoMoreIDE is not running|Looking for NoMoreIDE/ })).toBeDefined()
  await ui.press({ key: 'tab-git' })
  expect(await ui.find({ type: 'Text', text: /No git repository here/ })).toBeDefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'nomoreide',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

const DAEMON: Record<string, unknown> = {
  '/api/services': {
    ok: true,
    services: [
      { name: 'web', port: 5173, kind: 'local', command: 'npm run dev', cwd: '/work/app/web' },
      { name: 'api', port: 3877, kind: 'local', command: 'cargo run', cwd: '/work/app/api' },
      { name: 'other-db', port: 5432, kind: 'docker-compose', cwd: '/elsewhere/db' },
    ],
  },
  '/api/status': {
    ok: true,
    status: {
      services: {
        web: { name: 'web', state: 'running', pid: 4242, exitCode: null, url: 'http://127.0.0.1:5173' },
        api: { name: 'api', state: 'exited', pid: null, exitCode: 101, url: null },
      },
    },
  },
  '/api/errors?limit=50': {
    ok: true,
    incidents: [
      {
        id: 7,
        service: 'api',
        level: 'error',
        signature: 'panic',
        title: "thread 'main' panicked at src/main.rs:12",
        file: 'src/main.rs',
        line: 12,
        firstSeen: '2026-10-09T08:00:00.000Z',
        lastSeen: '2026-10-09T08:05:00.000Z',
        count: 3,
        logExcerpt: 'thread main panicked\nnote: run with RUST_BACKTRACE=1',
      },
    ],
  },
  '/api/agent/change-sets': {
    ok: true,
    sessions: [
      {
        id: 'run-1',
        label: 'tidy the parser',
        provider: 'claude',
        repoPath: '/work/app',
        snapshotSha: 'abc1234def',
        startedAt: '2026-10-09T07:00:00.000Z',
        lastToolAt: '2026-10-09T08:00:00.000Z',
        toolCount: 12,
      },
      { id: 'run-2', repoPath: '/elsewhere/site', startedAt: '2026-10-09T06:00:00.000Z', lastToolAt: '', toolCount: 3 },
    ],
  },
  '/api/agent/change-sets/run-1': {
    ok: true,
    files: [
      { status: 'M', path: 'src/parse.ts' },
      { status: 'A', path: 'src/new.ts' },
    ],
  },
  'POST /api/agent/change-sets/run-1/restore': {
    ok: true,
    restoredFiles: 2,
    deletedPaths: ['src/new.ts'],
    preRestore: { sha: 'feedbeef1234', ref: 'r', label: 'pre-restore', createdAt: '2026-10-09T08:10:00.000Z' },
  },
  '/api/agent/usage': {
    ok: true,
    usage: {
      claude: {
        costUSD: 3.5,
        linesAdded: 40,
        linesRemoved: 7,
        fiveHour: { usedPercent: 42, resetsAtUnix: 1_791_540_000 },
        weekly: { usedPercent: 91, resetsAtUnix: 1_791_900_000 },
      },
    },
  },
  '/api/agent/usage/history': {
    ok: true,
    entries: [],
    summary: {
      runs: 9,
      totalCostUSD: 21.25,
      totalTokens: 1_250_000,
      codexTotalTokens: 0,
      byDay: [
        { date: '2026-10-08', costUSD: 8, runs: 4, totalTokens: 1 },
        { date: '2026-10-09', costUSD: 13.25, runs: 5, totalTokens: 1 },
      ],
    },
  },
  '/api/agent': {
    ok: true,
    agent: {
      agents: {
        'claude-code': {
          skills: [{ name: 'deploy', scope: 'user', path: '/x' }],
          mcpServers: [{ name: 'linear', scope: 'user', type: 'http', url: 'https://mcp.example/?key=SECRET' }],
          plugins: [{ name: 'nomoreide', scope: 'user', version: '0.1.0' }],
          hooks: [{ event: 'PreToolUse', scope: 'project', type: 'command', command: 'TOKEN=SECRET run', status: 'ok' }],
        },
      },
    },
  },
  '/api/linear/connection': { ok: true, connected: true },
  'POST /api/linear/request {"operation":"metadata"}': {
    ok: true,
    data: { viewer: { id: 'me', name: 'T' }, teams: { nodes: [{ id: 'team-1', name: 'Eng' }] }, binding: null },
  },
  'POST /api/linear/request {"operation":"issues","team":"team-1","project":null,"after":null}': {
    ok: true,
    data: {
      issues: {
        nodes: [
          {
            id: 'i1',
            identifier: 'ENG-7',
            title: 'Fix the login redirect',
            description: 'It loops.',
            url: 'https://linear.app/t/issue/ENG-7',
            branchName: 'eng-7-fix-login',
            state: { id: 's1', name: 'In Progress', type: 'started' },
            assignee: { id: 'me', name: 'T' },
            updatedAt: '2026-10-09T08:00:00.000Z',
          },
          {
            id: 'i2',
            identifier: 'ENG-8',
            title: 'Done already',
            url: 'https://linear.app/t/issue/ENG-8',
            state: { id: 's2', name: 'Done', type: 'completed' },
            assignee: { id: 'me', name: 'T' },
          },
          {
            id: 'i3',
            identifier: 'ENG-9',
            title: 'Someone else has this',
            url: 'https://linear.app/t/issue/ENG-9',
            state: { id: 's3', name: 'Todo', type: 'unstarted' },
            assignee: { id: 'them', name: 'Other' },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  },
  '/api/services/web/logs?lines=60': {
    ok: true,
    logs: [
      { service: 'web', stream: 'stdout', text: 'ready in 320ms', timestamp: '2026-10-09T08:00:00Z' },
      { service: 'web', stream: 'stderr', text: 'failed to resolve import', timestamp: '2026-10-09T08:00:01Z', severity: 'error' },
    ],
  },
  '/api/errors/7/prompt': { ok: true, prompt: 'Fix the panic in src/main.rs:12' },
  '/api/services/api/start': { ok: true, status: {} },
}

test('the daemon tabs draw services, errors, the console and Linear, and act on them', async ($, on) => {
  const asked: string[] = []
  const filled: string[] = []
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: Date.parse('2026-10-09T08:10:00.000Z') })
  on('session.cwd', () => ({ value: '/work/app' }))
  on('config.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({
    value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.read', (_$, e) => ({
    value: e.path.endsWith('daemon.json') ? '{"url":"http://127.0.0.1:4317","port":4317}' : 'ab'.repeat(32),
  }))
  on('http.fetch', (_$, e) => {
    const path = e.url.replace('http://127.0.0.1:4317', '')
    const method = e.init?.method ?? 'GET'
    asked.push(`${method} ${path} ${e.init?.headers?.authorization ?? ''}`)
    if (path === '/api/agent/change-sets/run-1/diff?path=src%2Fparse.ts') {
      return { value: { status: 200, ok: true, headers: {}, text: DIFF } }
    }
    const sent = typeof e.init?.body === 'string' ? ` ${e.init.body}` : ''
    const body =
      method === 'GET'
        ? DAEMON[path.replace(/\?since=.*$/, '')]
        : (DAEMON[`POST ${path}${sent}`] ?? DAEMON[`POST ${path}`] ?? DAEMON[path])

    return {
      value: {
        status: body === undefined ? 404 : 200,
        ok: body !== undefined,
        headers: {},
        text: JSON.stringify(body ?? { ok: false, error: 'Not found' }),
      },
    }
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })

  await $.command.run(typed('services'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The first daemon read was started by the command and lands on its own.
    await ui.redraw()

    expect(await ui.find({ key: 'restart:web' }), 'a running service').toBeDefined()
    expect(await ui.find({ key: 'start:api' }), 'a failed service').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ELSEWHERE/ }), 'another project').toBeDefined()
    await ui.press({ key: 'start:api' })
    expect(asked).toContain(`POST /api/services/api/start Bearer ${'ab'.repeat(32)}`)

    await ui.press({ key: 'logs:web' })
    expect(await ui.find({ type: 'Text', text: 'failed to resolve import' }), 'a log line').toBeDefined()
    await ui.press({ key: 'back' })

    await ui.press({ key: 'tab-errors' })
    expect(await ui.find({ key: 'incident:7' }), 'an error row').toBeDefined()
    await ui.press({ key: 'incident:7' })
    expect(await ui.find({ type: 'Code' }), 'its log excerpt').toBeDefined()
    await ui.press({ key: 'fix' })
    expect(filled).toContain('Fix the panic in src/main.rs:12')
    await ui.press({ key: 'back' })

    // What the AI touched: this folder's sessions only, each down to a file's diff.
    await ui.press({ key: 'tab-console' })
    expect(await ui.find({ key: 'set:run-1' }), 'a session of this folder').toBeDefined()
    expect(await ui.find({ key: 'set:run-2' }), "another folder's session").toBeUndefined()
    await ui.press({ key: 'set:run-1' })
    expect(await ui.find({ key: 'setfile:src/new.ts' }), 'a file it changed').toBeDefined()
    await ui.press({ key: 'setfile:src/parse.ts' })
    expect(await ui.find({ type: 'Code' }), 'its diff since the snapshot').toBeDefined()
    await ui.press({ key: 'back' })

    // Putting files back takes two presses, and the first one changes nothing.
    const restore = `POST /api/agent/change-sets/run-1/restore Bearer ${'ab'.repeat(32)}`
    const before = asked.filter(one => one === restore).length
    await ui.press({ key: 'restore-set:run-1' })
    expect(asked.filter(one => one === restore).length, 'asked first').toBe(before)
    await ui.press({ key: 'no:restore-set:run-1' })
    expect(await ui.find({ key: 'yes:restore-set:run-1' }), 'called off').toBeUndefined()
    await ui.press({ key: 'restore-set:run-1' })
    await ui.press({ key: 'yes:restore-set:run-1' })
    expect(asked.filter(one => one === restore).length, 'then done').toBe(before + 1)
    expect(await ui.find({ type: 'Text', text: /Restored 2 files, removed 1\. To undo, restore snapshot feedbee/ })).toBeDefined()
    await ui.press({ key: 'back' })

    await ui.press({ key: 'section-usage' })
    expect(await ui.find({ type: 'Text', text: '91%' }), 'a limit').toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$21.25' }), "the period's cost").toBeDefined()

    await ui.press({ key: 'section-tools' })
    expect(await ui.find({ type: 'Text', text: /MCP SERVERS/ }), 'a kind of tool').toBeDefined()
    await ui.press({ key: 'tools-mcp' })
    expect(await ui.find({ key: 'tool:mcp:linear' }), 'a server by name').toBeDefined()
    await ui.press({ key: 'tool:mcp:linear' })
    expect(filled).toContain('the linear MCP server ')
    await ui.press({ key: 'tools-mcp' })
    await ui.press({ key: 'tools-skills' })
    await ui.press({ key: 'tool:skills:deploy' })
    expect(filled).toContain('/deploy ')
    await ui.press({ key: 'tools-mcp' })
    expect(JSON.stringify(await ui.drawn()), 'never its address').not.toMatch(/SECRET/)
    await ui.press({ key: 'tools-mcp' })
    await ui.press({ key: 'section-changes' })

    await ui.press({ key: 'tab-linear' })
    expect(await ui.find({ key: 'task:ENG-7' }), 'an open task of mine').toBeDefined()
    expect(await ui.find({ key: 'task:ENG-8' }), 'a finished one').toBeUndefined()
    expect(await ui.find({ key: 'task:ENG-9' }), "someone else's").toBeUndefined()
    await ui.press({ key: 'task:ENG-7' })
    expect(filled.some(text => text.startsWith('Work on Linear task ENG-7: Fix the login redirect'))).toBe(true)

    await ui.press({ key: 'tab-services' })
    await ui.unmount()
  }

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /1 error/ }), 'the band').toBeDefined()
  expect(await band.find({ key: 'open' }), 'the way to the pane').toBeDefined()
  await band.unmount()
})

test('web opens the dashboard in the browser and draws nothing of it', async ($, on) => {
  const ran: string[] = []
  mock.env(on, { HOME: '/home/t' })
  on('process.run', (_$, e) => {
    ran.push(e.argv.join(' '))

    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('fs.read', (_$, e) => {
    if (e.path.endsWith('daemon.json')) return { value: '{"url":"http://127.0.0.1:4317"}' }
    if (e.path.endsWith('daemon.credential')) return { value: 'ab'.repeat(32) }

    return { deny: 'no such file' }
  })

  const answer = await $.command.run(typed('web'))
  expect(ran).toEqual(['open http://127.0.0.1:4317/git'])
  expect(JSON.stringify(answer)).toMatch(/open in your browser/)
})

const PULL = JSON.stringify({
  number: 12,
  title: 'Add the parser',
  url: 'https://github.com/t/app/pull/12',
  state: 'OPEN',
  isDraft: false,
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
  ],
})

test('a pull request is read from gh: its checks tallied, anything else refused', () => {
  expect(parsePull('/work/app', PULL)).toMatchObject({ number: 12, checks: 'failing', passed: 1, total: 3 })
  expect(
    parsePull('/r', JSON.stringify({ number: 1, url: 'https://x/1', statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }))
      ?.checks,
  ).toBe('running')
  expect(parsePull('/r', JSON.stringify({ number: 1, url: 'https://x/1', statusCheckRollup: [] }))?.checks).toBe('none')
  // Only an https address is ever handed to `open`.
  expect(parsePull('/r', JSON.stringify({ number: 1, url: 'file:///etc/passwd' }))?.url).toBe('')
  expect(parsePull('/r', 'no pull requests found for branch "main"')).toBeNull()
})

test('what is installed is listed by name, never by address or command', () => {
  const tools = toTools(DAEMON['/api/agent'])

  expect(tools.mcp).toEqual([{ name: 'linear', detail: 'user · http' }])
  expect(tools.hooks).toEqual([{ name: 'PreToolUse', detail: 'project · command · ok' }])
  expect(JSON.stringify(tools)).not.toMatch(/SECRET/)
})

test('a click that only brought the keyboard is a press, once', () => {
  const click = { origin: { kind: 'person' }, element: 'tab-git' }
  const unfocused = { isDesktopFocused: false, hasTerminal: false }

  // The desktop pane was not holding the keys: the focus move is the click.
  expect(isFocusOnlyClick(unfocused, click)).toBe(true)
  // Holding them, the app raises the press itself.
  expect(isFocusOnlyClick({ isDesktopFocused: true, hasTerminal: false }, click)).toBe(false)
  // Never drawn on desktop, or drawn in a terminal, where a click is a press.
  expect(isFocusOnlyClick({ isDesktopFocused: undefined, hasTerminal: false }, click)).toBe(false)
  expect(isFocusOnlyClick({ isDesktopFocused: false, hasTerminal: true }, click)).toBe(false)
  // The mod's own `$.ui.focus`, and the engine's own stops, are not clicks on a button.
  expect(isFocusOnlyClick(unfocused, { origin: { kind: 'plugin' }, element: 'tab-git' })).toBe(false)
  expect(isFocusOnlyClick(unfocused, { origin: { kind: 'person' } })).toBe(false)

  // A press for the same button soon after is the same click, raised late.
  const answered = { key: 'tab-git', at: 1_000 }
  expect(isEcho(answered, 'tab-git', 1_000 + ECHO_MS - 1)).toBe(true)
  expect(isEcho(answered, 'tab-git', 1_000 + ECHO_MS)).toBe(false)
  expect(isEcho(answered, 'tab-errors', 1_001)).toBe(false)
  expect(isEcho({ key: '', at: 0 }, undefined, 1)).toBe(false)
})

test('the Git view shows the pull request and takes and restores snapshots of the selected repository', async ($, on) => {
  const asked: string[] = []
  const opened: string[] = []
  let active = '/work/app'
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: Date.parse('2026-10-09T08:10:00.000Z') })
  on('session.cwd', () => ({ value: '/work/app' }))
  on('config.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('process.run', (_$, e) => {
    const [bin, ...rest] = e.argv
    const args = rest.filter(arg => arg !== '--no-optional-locks')
    if (bin === 'open') opened.push(args.join(' '))
    const stdout =
      bin === 'gh' ? PULL : args[0] === 'rev-parse' ? '/work/app\n' : args[0] === 'status' ? '## main...origin/main\0' : ''

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('fs.read', (_$, e) => ({
    value: e.path.endsWith('daemon.json') ? '{"url":"http://127.0.0.1:4317"}' : 'ab'.repeat(32),
  }))
  on('http.fetch', (_$, e) => {
    const path = e.url.replace('http://127.0.0.1:4317', '')
    const method = e.init?.method ?? 'GET'
    asked.push(`${method} ${path}${typeof e.init?.body === 'string' ? ` ${e.init.body}` : ''}`)
    const body: unknown =
      path === '/api/git/worktrees'
        ? { ok: true, activePath: active, worktrees: [] }
        : path === '/api/snapshots'
          ? { ok: true, snapshots: [{ sha: 'abc1234def', ref: 'r', label: 'before the refactor', createdAt: '2026-10-09T07:10:00.000Z' }] }
          : path === '/api/snapshots/abc1234def/restore'
            ? { ok: true, restoredFiles: 3, deletedPaths: [], preRestore: { sha: 'feedbeef1234' } }
            : path === '/api/services'
              ? { ok: true, services: [] }
              : path === '/api/status'
                ? { ok: true, status: { services: {} } }
                : path === '/api/errors?limit=50'
                  ? { ok: true, incidents: [] }
                  : undefined

    return {
      value: {
        status: body === undefined ? 404 : 200,
        ok: body !== undefined,
        headers: {},
        text: JSON.stringify(body ?? { ok: false, error: 'Not found' }),
      },
    }
  })

  await $.command.run(typed('git'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.redraw()

    expect(await ui.find({ type: 'Text', text: 'checks failing' }), 'how the checks stand').toBeDefined()
    await ui.press({ key: 'pull' })
    expect(opened).toContain('https://github.com/t/app/pull/12')

    await ui.press({ key: 'snapshot' })
    expect(asked).toContain('POST /api/snapshots {"label":"from Claude Code"}')

    await ui.press({ key: 'restore:abc1234def' })
    expect(asked).not.toContain('POST /api/snapshots/abc1234def/restore')
    await ui.press({ key: 'yes:restore:abc1234def' })
    expect(asked).toContain('POST /api/snapshots/abc1234def/restore')
    asked.length = 0

    await ui.unmount()
  }

  // The daemon moved to another repository under the open pane: a snapshot
  // it would take now is not of this one, so none is asked for.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  active = '/elsewhere/site'
  await ui.press({ key: 'snapshot' })
  expect(asked.some(one => one.startsWith('POST /api/snapshots'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /another repository selected/ })).toBeDefined()
  await ui.unmount()
})
