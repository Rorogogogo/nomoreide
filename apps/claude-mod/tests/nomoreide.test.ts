import { expect, mock, test } from 'claude-code/testing'

import { endpointOf, toTools } from '../hooks/daemon'
import { ECHO_MS, isEcho, isFocusOnlyClick } from '../hooks/focus'
import { DIFF_LINES_CAP, diffRows, fitHunks, layoutMessage, moreDiffLines, parseLog, parseNameStatus, parsePull, parsePulls, parseStatus } from '../hooks/git'
import { graphSvg } from '../hooks/icons'
import { controlArgv, lineAt, parseLrc, parseNowPlaying, pickLrclib, pickNetease, positionOf, settle } from '../hooks/music'

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

test('a diff is read into rows, each numbered on the side it is on', () => {
  expect(diffRows('@@ -1,3 +1,3 @@ fn main\n const a = 1\n-const b = 2\n+const b = 3\n const c = 4')).toEqual([
    { kind: 'hunk', before: null, after: null, text: 'fn main' },
    { kind: 'same', before: 1, after: 1, text: 'const a = 1' },
    { kind: 'removed', before: 2, after: null, text: 'const b = 2' },
    { kind: 'added', before: null, after: 2, text: 'const b = 3' },
    { kind: 'same', before: 3, after: 3, text: 'const c = 4' },
  ])
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
  const toasts: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
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
    // A cell grid has the engine's own diff; elsewhere its lines are drawn on their grounds.
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Code' }), 'the diff').toBeDefined()
    } else {
      // Drawn as a review on GitHub shows one: a fixed-width face, the code in its own
      // colours, the added line on its green ground and the removed one on its red.
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn, 'the added line').toMatch(/rect class=\\"ag\\"[^/]*\/>.*keyword[^>]*>const<\/tspan> b = <tspan class=[^>]*number[^>]*>3</)
      expect(drawn, 'the removed line').toMatch(/rect class=\\"rg\\"/)
      expect(drawn, 'both sides numbered').toMatch(/text-anchor=\\"end\\">3<\/text><text class=\\"d\\"[^>]*>3</)
      expect(drawn).toMatch(/ui-monospace/)
    }
    await ui.press({ key: 'back' })
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/const b = 3|const<\/tspan> b = /)

    await ui.unmount()
  }
})

test('with no daemon the other tabs say so and draw nothing else', async ($, on) => {
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/work/app' }))
  on('config.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
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
    data: {
      viewer: { id: 'me', name: 'T' },
      teams: {
        nodes: [
          {
            id: 'team-1',
            name: 'Eng',
            states: { nodes: [{ id: 'st-doing', name: 'In Progress', type: 'started' }, { id: 'st-done', name: 'Done', type: 'completed' }] },
          },
        ],
      },
      binding: null,
    },
  },
  'POST /api/linear/request {"operation":"update","id":"i1","state":"st-done"}': {
    ok: true,
    data: {},
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
            team: { id: 'team-1', name: 'Eng' },
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
  const posted: string[] = []
  const filled: string[] = []
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: Date.parse('2026-10-09T08:10:00.000Z') })
  on('session.cwd', () => ({ value: '/work/app' }))
  on('config.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
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
    if (sent !== '') posted.push(`${path}${sent}`)
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
    // A cell grid types the line; elsewhere it is drawn, in a fixed-width face.
    expect(JSON.stringify(await ui.drawn()), 'a log line').toContain('failed to resolve import')
    await ui.press({ key: 'back' })

    await ui.press({ key: 'tab-errors' })
    expect(await ui.find({ key: 'incident:7' }), 'an error row').toBeDefined()
    await ui.press({ key: 'incident:7' })
    expect(JSON.stringify(await ui.drawn()), 'its log excerpt').toContain(surface === 'terminal' ? '"borderStyle":"round"' : 'output, lines')
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
    expect(JSON.stringify(await ui.drawn()), 'its diff since the snapshot').toMatch(
      surface === 'terminal' ? /const b = 3/ : /const<\/tspan> b = /,
    )
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
    expect(toasts.some(one => /Restored 2 files, removed 1\. To undo, restore snapshot feedbee/.test(one)), 'said in a toast').toBe(true)
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
    // Changing what is installed is asked of Claude, drafted and never done by the pane.
    await ui.press({ key: 'remove-tool:mcp:0' })
    expect(filled.some(text => text.includes('Run `claude mcp remove linear` (scope: user).'))).toBe(true)
    await ui.press({ key: 'ask-add:hooks' })
    expect(filled.some(text => text.startsWith('Add a new hook for Claude Code.') && text.endsWith('The hook to add: '))).toBe(true)
    expect(filled.join('\n'), 'no address, no command').not.toMatch(/SECRET/)
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
    // An issue in progress is finished with a press: its team's own completed state.
    expect(await ui.find({ key: 'task-start:ENG-7' }), 'already started').toBeUndefined()
    await ui.press({ key: 'task-done:ENG-7' })
    expect(posted).toContain('/api/linear/request {"operation":"update","id":"i1","state":"st-done"}')

    await ui.press({ key: 'tab-services' })
    await ui.unmount()
  }

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /1 error/ }), 'the band').toBeDefined()
  expect(await band.find({ key: 'open' }), 'the way to the pane').toBeDefined()
  expect(await band.find({ type: 'Text', text: '42%' }), 'the five-hour limit').toBeDefined()
  expect(await band.find({ type: 'Text', text: '91%' }), 'the weekly limit').toBeDefined()
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

  expect(tools.mcp).toEqual([{ name: 'linear', detail: 'user · http', scope: 'user', where: '' }])
  expect(tools.hooks).toEqual([{ name: 'PreToolUse', detail: 'project · command · ok', scope: 'project', where: '' }])
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
  const toasts: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
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
  expect(toasts.some(one => /another repository selected/.test(one)), 'said in a toast').toBe(true)
  await ui.unmount()
})

const LRC = '[00:00.00] 作词 : someone\n[00:21.87]first line\n[00:25.50][01:10.00]second line\n[00:29.67]\n[00:33]third line\n'

test('what is playing is read, its place in the song told, and a lyric file put in order', () => {
  const song = parseNowPlaying(
    '{"app":"com.netease.163music","playing":true,"title":" Song ","artist":"Singer","duration":200,"elapsedtime":10,"playbackrate":1,"at":1000}',
  )
  expect(song).toEqual({
    app: 'com.netease.163music',
    title: 'Song',
    artist: 'Singer',
    album: '',
    duration: 200,
    elapsed: 10,
    at: 1_000_000,
    isPlaying: true,
  })
  expect(parseNowPlaying('{}'), 'nothing playing').toBeNull()
  expect(parseNowPlaying('not json')).toBeNull()
  if (song === null) return
  expect(positionOf(song, 1_005_000), 'five seconds on').toBe(15)
  expect(positionOf({ ...song, isPlaying: false }, 1_005_000), 'paused stays put').toBe(10)
  expect(positionOf(song, 9_000_000), 'never past the end').toBe(200)

  const lines = parseLrc(LRC)
  expect(lines.map(line => line.text), 'credits and empty lines dropped').toEqual([
    'first line',
    'second line',
    'third line',
    'second line',
  ])
  expect(lines[0]?.at).toBe(21.87)
  expect(lineAt(lines, 5), 'before the first').toBe(-1)
  expect(lineAt(lines, 26)).toBe(1)
  expect(lineAt(lines, 500)).toBe(3)

  const found = [
    { duration: 150, syncedLyrics: 'far' },
    { duration: 201, syncedLyrics: 'near' },
    { duration: 200, syncedLyrics: null },
  ]
  expect(pickLrclib(found, 200), 'the timed one nearest in length').toBe('near')
  expect(pickLrclib(found, 90)).toBe('')
  expect(pickNetease({ result: { songs: [{ id: 1, duration: 120_000 }, { id: 2, duration: 199_000 }] } }, song)).toBe(2)

  // Paused at 15s for ten seconds, unreported: the song stands, then goes on from where it stopped.
  const paused = settle(song, true, null, 1_005_000)
  expect(positionOf(paused.track, 1_012_000), 'stands while paused').toBe(15)
  const resumed = settle(song, false, paused.held, 1_015_000)
  expect(positionOf(resumed.track, 1_017_000), 'goes on from there').toBe(17)
  expect(controlArgv('com.spotify.client', 'next').at(-1)).toBe('tell application "Spotify" to next track')
})

test('chill mode shows the song and its lyric in the pane and above the prompt, and sends what is pressed', async ($, on) => {
  const ran: string[][] = []
  const fetched: string[] = []
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/work/app' }))
  on('config.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    const isPlayer = e.argv[0] === 'osascript' && e.argv[1] === '-l'
    const isProbe = e.argv[0] === 'osascript' && (e.argv[2] ?? '').includes('get name of menu item 1')
    const stdout = isPlayer
      ? '{"app":"com.netease.163music","playing":true,"title":"Song","artist":"Singer","duration":200,"elapsedtime":26}'
      : isProbe
        ? 'Play\n'
        : ''

    return {
      value: {
        exitCode: e.argv[0] === 'osascript' ? 0 : 128,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('http.fetch', (_$, e) => {
    fetched.push(e.url)
    const text = e.url.startsWith('https://lrclib.net/') ? JSON.stringify([{ duration: 200, syncedLyrics: LRC }]) : '{}'

    return { value: { status: 200, ok: true, headers: {}, text } }
  })

  await $.command.run(typed('git'))
  {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: 'NOW PLAYING' }), 'off until asked for').toBeUndefined()
    expect(fetched.some(url => url.includes('lrclib')), 'nothing looked up while off').toBe(false)
    await ui.press({ key: 'chill' })
    await clock.advance(3_000)
    expect(await ui.find({ type: 'Text', text: 'Song' }), 'the song').toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'second line' }), 'the line being sung').toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'first line' }), 'the one before').toBeDefined()
    expect(fetched.find(url => url.includes('lrclib')), 'by title and artist').toContain('track_name=Song&artist_name=Singer')
    const closed = JSON.stringify(await ui.drawn()).split('second line').length
    await ui.press({ key: 'chill-wide' })
    expect(JSON.stringify(await ui.drawn()).split('second line').length, 'opened up: more of the lyric').toBeGreaterThan(closed)
    await ui.press({ key: 'media-next' })
    expect(ran.some(argv => (argv[2] ?? '').includes('click menu item 2 of menu 1')), "next, by NetEase's own menu").toBe(true)
    expect(JSON.stringify(await ui.drawn()), 'a pause the player never reported').toContain('"label":"▶\uFE0E"')
    await ui.unmount()
  }

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'second line' }), 'the lyric above the prompt').toBeDefined()
  expect(await band.find({ key: 'open' }), 'one row: the lyric has it').toBeUndefined()
  await band.unmount()
})

const LOG = [
  '* \x1fabc1234\x1fAdd the parser\x1fRo\x1f1791540000\x1fHEAD -> main, origin/main',
  '|\\  ',
  '| * \x1fdef5678\x1fFix a typo\x1fSam\x1f1791530000\x1ffeat/typo, tag: v1',
  '|/  ',
  '* \x1f0123abc\x1fFirst commit\x1fRo\x1f1791520000\x1f',
].join('\n')

test('the commit graph, a commit\'s files and the pull request list are read', () => {
  const rows = parseLog(LOG)
  expect(rows.map(row => row.sha)).toEqual(['abc1234', '', 'def5678', '', '0123abc'])
  expect(rows[0]?.refs, 'HEAD is the branch it is on').toEqual(['main', 'origin/main'])
  expect(rows[2]?.refs).toEqual(['feat/typo', 'v1'])
  expect(rows[2]?.graph, 'the lane the commit is on').toBe('| *')
  expect(rows[0]?.at).toBe(1_791_540_000_000)
  expect(graphSvg('| *'), 'a line down and a dot').toMatch(/<path[^>]*\/><path[^>]*\/><circle/)
  expect(parseNameStatus('M\tsrc/a.ts\nR100\told.ts\tnew.ts\nA\tb.md\n')).toEqual([
    { status: 'M', path: 'src/a.ts' },
    { status: 'R', path: 'new.ts' },
    { status: 'A', path: 'b.md' },
  ])
  const pulls = parsePulls(
    '/work/app',
    JSON.stringify([
      {
        number: 12,
        title: 'Add the parser',
        url: 'https://github.com/o/r/pull/12',
        state: 'OPEN',
        isDraft: true,
        headRefName: 'feat/parser',
        author: { login: 'ro' },
        updatedAt: '2026-10-09T08:00:00Z',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
      },
      { title: 'not a pull request' },
    ]),
  )
  expect(pulls.length).toBe(1)
  expect(pulls[0]).toMatchObject({ number: 12, branch: 'feat/parser', author: 'ro', checks: 'failing', passed: 1, total: 2 })
  expect(parsePulls('/work/app', 'not json')).toEqual([])
})

test('History shows the graph and opens a commit and its diff; PRs lists them and drafts a review', async ($, on) => {
  const ran: string[][] = []
  const filled: string[] = []
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/work/app' }))
  on('config.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('process.run', (_$, e) => {
    const args = e.argv.filter(arg => arg !== '--no-optional-locks').slice(1)
    ran.push([...e.argv])
    const isGh = e.argv[0] === 'gh'
    const stdout = isGh
      ? args[0] === 'pr' && args[1] === 'list'
        ? JSON.stringify([
            {
              number: 12,
              title: 'Add the parser',
              url: 'https://github.com/o/r/pull/12',
              state: 'OPEN',
              isDraft: false,
              headRefName: 'feat/parser',
              author: { login: 'ro' },
              updatedAt: '2026-10-09T08:00:00Z',
              statusCheckRollup: [{ conclusion: 'SUCCESS' }],
            },
          ])
        : ''
      : args[0] === 'rev-parse'
        ? '/work/app\n'
        : args[0] === 'status'
          ? STATUS
          : args[0] === 'log'
            ? LOG
            : args[0] === 'show' && args.includes('--no-patch')
              ? 'def5678\x1fFix a typo\x1fSam\x1f1791530000\x1fA longer word about it.\n'
              : args[0] === 'show' && args.includes('--name-status')
                ? 'M\tsrc/app.ts\n'
                : args[0] === 'show'
                  ? DIFF
                  : ''

    return {
      value: { exitCode: isGh && stdout === '' ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  await $.command.run(typed('history'))
  await clock.advance(3_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'commit:abc1234' }), 'a commit by its subject').toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'feat/typo' }), 'the branch at a commit').toBeDefined()
    await ui.press({ key: 'commit:def5678' })
    expect(await ui.find({ type: 'Text', text: 'Fix a typo' }), 'the commit opened').toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'A longer word about it.' }), 'its message').toBeDefined()
    await ui.press({ key: 'cfile:src/app.ts' })
    expect(ran.some(argv => argv.includes('show') && argv.includes('def5678') && argv.includes('src/app.ts')), 'that file in that commit').toBe(true)
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'cfile:src/app.ts' }), 'back to its files').toBeDefined()
    await ui.press({ key: 'back' })

    await ui.press({ key: 'section-pulls' })
    await clock.advance(1_000)
    expect(await ui.find({ key: 'pr:12' }), 'an open pull request').toBeDefined()
    await ui.press({ key: 'pr-review:12' })
    expect(filled.some(text => text.includes('12')), 'a review drafted, not sent').toBe(true)
    await ui.press({ key: 'section-history' })
    await ui.unmount()
  }
  expect(ran.some(argv => argv[0] === 'gh' && argv.includes('list')), 'asked of gh').toBe(true)
})

test('a cut diff grows by a screenful a press, up to the most a pane draws', () => {
  const raw = ['diff --git a/a.txt b/a.txt', '@@ -1,0 +1,1000 @@', ...Array.from({ length: 1000 }, (_, at) => `+line ${at}`)].join('\n')
  const first = fitHunks(raw)
  expect(first.hiddenLines, 'the first screenful leaves the rest out').toBe(601)
  const next = fitHunks(raw, moreDiffLines(first.hunks))
  expect(next.hunks.split('\n').length).toBe(800)
  expect(next.hiddenLines).toBe(201)
  expect(next.hunks.split('\n')[0], 'the cut hunk still counts its own lines').toBe('@@ -1,0 +1,799 @@')
  expect(fitHunks(raw, moreDiffLines(next.hunks)).hiddenLines, 'then all of it').toBe(0)
  expect(moreDiffLines(Array.from({ length: DIFF_LINES_CAP }, () => '+x').join('\n')), 'never past the cap').toBe(DIFF_LINES_CAP)
})

test('a commit body is joined for the pane to wrap, its list hung and its trailers set apart', () => {
  const laid = layoutMessage(
    [
      'The diff viewer highlights added lines in the',
      "file's language. A file of",
      'no known language stays two-colour.',
      '',
      '- Git: History and',
      '  PRs',
      '- Logs sit in a card',
      '',
      'Co-authored-by: A Person <a@example.com>',
      'Claude-Session: https://claude.ai/code/session_01',
    ].join('\n'),
  )
  expect(laid.paragraphs[0]).toEqual([
    { mark: '', text: "The diff viewer highlights added lines in the file's language. A file of no known language stays two-colour." },
  ])
  expect(laid.paragraphs[1]).toEqual([
    { mark: '-', text: 'Git: History and PRs' },
    { mark: '-', text: 'Logs sit in a card' },
  ])
  expect(laid.trailers).toEqual([
    { key: 'Co-authored-by', value: 'A Person <a@example.com>' },
    { key: 'Claude-Session', value: 'https://claude.ai/code/session_01' },
  ])
  expect(layoutMessage('Note: this is prose, and the only paragraph.\n\nMore prose here.').trailers, 'prose is not a trailer').toEqual([])
})
