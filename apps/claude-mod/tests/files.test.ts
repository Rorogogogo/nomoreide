import { expect, mock, test } from 'claude-code/testing'

import {
  applyEdit,
  familyOf,
  holdsChanges,
  isUnder,
  linesOf,
  matchNames,
  parseGrep,
  sortEntries,
  statusOf,
  tagOf,
  windowFor,
} from '../hooks/files'
import { applyKey, bufferOf, scrolled, textOf } from '../hooks/edit-buffer'
import { parseJobs, parseRuns, standingOf, toRunPrompt } from '../hooks/github'
import { highlight, isHighlighted, sliceTokens } from '../hooks/highlight'
import { wrapLine } from '../hooks/icons'
import { commitMessagePrompt, queryPrompt, removeToolPrompt } from '../hooks/prompts'

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

const typed = (args: string) =>
  ({
    command: 'nomoreide',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  }) as const

test('one line of a file is changed and the rest is left as it was', () => {
  expect(applyEdit('a\nb\nc\n', { kind: 'replace', line: 2, value: 'B' })).toBe('a\nB\nc\n')
  // No final newline stays none; a CRLF file keeps its endings.
  expect(applyEdit('a\nb', { kind: 'replace', line: 2, value: 'B' })).toBe('a\nB')
  expect(applyEdit('a\r\nb\r\n', { kind: 'replace', line: 1, value: 'A' })).toBe('A\r\nb\r\n')
  expect(applyEdit('a\nb\n', { kind: 'insert', line: 1 })).toBe('a\n\nb\n')
  expect(applyEdit('a\nb\n', { kind: 'insert', line: 0 })).toBe('\na\nb\n')
  expect(applyEdit('', { kind: 'insert', line: 0 })).toBe('\n')
  expect(applyEdit('a\nb\nc\n', { kind: 'delete', line: 2 })).toBe('a\nc\n')
  // A text field is one line: a pasted break does not make two.
  expect(applyEdit('a\n', { kind: 'replace', line: 1, value: 'x\ny' })).toBe('x y\n')
  expect(applyEdit('a\n', { kind: 'replace', line: 5, value: 'x' })).toBeUndefined()
  expect(applyEdit('a\n', { kind: 'delete', line: 0 })).toBeUndefined()

  expect(linesOf('a\nb\n')).toEqual(['a', 'b'])
  expect(windowFor(45, 40, 100)).toBe(40)
  expect(isUnder('/work/app/src/a.ts', '/work/app')).toBe(true)
  expect(isUnder('/work/app/../secrets', '/work/app')).toBe(false)
  expect(isUnder('/work/application', '/work/app')).toBe(false)
  expect(sortEntries([{ name: 'b.ts', kind: 'file' }, { name: '.git', kind: 'dir' }, { name: 'src', kind: 'dir' }])).toEqual([
    { name: 'src', kind: 'dir' },
    { name: 'b.ts', kind: 'file' },
  ])
})

const RUNS = JSON.stringify([
  {
    databaseId: 91,
    workflowName: 'CI',
    displayTitle: 'Add the parser',
    status: 'completed',
    conclusion: 'failure',
    event: 'push',
    createdAt: '2026-10-09T08:00:00Z',
    url: 'https://github.com/t/app/actions/runs/91',
  },
  { databaseId: 92, workflowName: 'Deploy', displayTitle: 'Add the parser', status: 'in_progress', conclusion: '', event: 'push', url: 'javascript:alert(1)' },
  { workflowName: 'no id' },
])

const JOBS = JSON.stringify({
  jobs: [
    { name: 'lint', status: 'completed', conclusion: 'success', steps: [{ name: 'Run biome', conclusion: 'success' }] },
    {
      name: 'test (20)',
      status: 'completed',
      conclusion: 'failure',
      steps: [
        { name: 'Checkout', conclusion: 'success' },
        { name: 'Run npm test', conclusion: 'failure' },
      ],
    },
  ],
})

test('workflow runs and jobs are read from gh, and a failed one becomes a prompt', () => {
  const runs = parseRuns(RUNS)

  expect(runs.map(run => [run.id, standingOf(run)])).toEqual([
    [91, 'failed'],
    [92, 'running'],
  ])
  expect(runs[1]?.url, 'only https is ever opened').toBe('')
  expect(parseRuns('not json')).toEqual([])

  const jobs = parseJobs(JOBS)
  expect(jobs[1]).toEqual({ name: 'test (20)', status: 'completed', conclusion: 'failure', failedStep: 'Run npm test' })
  const [failed] = runs
  if (failed === undefined) throw new Error('no run')
  const prompt = toRunPrompt(failed, 'main', jobs)
  expect(prompt).toMatch(/job "test \(20\)", step "Run npm test"/)
  expect(prompt).toMatch(/gh run view 91 --log-failed/)
  expect(prompt).not.toMatch(/lint/)
})

test('files are browsed, read and changed a line at a time; runs are listed; a push asks first', async ($, on) => {
  const disk: Record<string, string> = {
    '/work/app/README.md': '# App\n\nold line\n',
    '/work/app/src/main.ts': 'export const a = 1\n',
  }
  const written: string[] = []
  const ran: string[] = []
  const filled: string[] = []
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: Date.parse('2026-10-09T08:10:00.000Z') })
  on('session.cwd', () => ({ value: '/work/app' }))
  on('config.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
  on('fs.list', (_$, e) => ({
    value:
      e.path === '/work/app'
        ? [entry('README.md', 'file'), entry('src', 'dir'), entry('.git', 'dir')]
        : [entry('main.ts', 'file')],
  }))
  on('fs.stat', (_$, e) => ({
    value: { kind: 'file' as const, size: (disk[e.path] ?? '').length, mtimeMs: 1 + written.length, isLink: false },
  }))
  on('fs.read', (_$, e) => {
    const text = disk[e.path]

    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    disk[e.path] = e.text
    written.push(e.path)

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const [bin, ...rest] = e.argv
    const args = rest.filter(arg => arg !== '--no-optional-locks')
    ran.push([bin, ...args].join(' '))
    const stdout =
      bin === 'gh'
        ? args[1] === 'list'
          ? RUNS
          : args[1] === 'view' && args.includes('jobs')
            ? JOBS
            : ''
        : args[0] === 'rev-parse'
          ? '/work/app\n'
          : args[0] === 'status'
            ? '## main...origin/main [ahead 1]\0'
            : args[0] === 'ls-files'
              ? 'README.md\nsrc/main.ts\nnode_modules/readme/index.js\n'
              : args[0] === 'grep'
                ? 'README.md:3:old line\nsrc/main.ts:1:export const a = 1\n'
                : ''

    return {
      value: {
        exitCode: bin === 'gh' && stdout === '' ? 1 : 0,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })

  await $.command.run(typed('files'))

  for (const surface of ['terminal', 'desktop'] as const) {
    disk['/work/app/README.md'] = '# App\n\nold line\n'
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.redraw()

    // A search finds files by name and lines by what they say, and opens either.
    await ui.input({ key: 'file-search', text: 'read' })
    expect(ran.some(one => one.endsWith('-e read')), 'the words are one argument').toBe(true)
    expect(await ui.find({ key: 'found:README.md' }), 'a file by name').toBeDefined()
    expect(await ui.find({ key: 'found:node_modules/readme/index.js' }), 'never a dependency').toBeUndefined()
    await ui.press({ key: 'hit:src/main.ts:1' })
    expect(await ui.find({ type: 'Code' }), 'the file the line is in').toBeDefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'search-clear' })
    await ui.press({ key: 'up' })

    // Folders open, `.git` is not offered, and the way back up appears a level down.
    expect(await ui.find({ key: 'entry:.git' })).toBeUndefined()
    await ui.press({ key: 'entry:src' })
    expect(await ui.find({ key: 'entry:main.ts' }), 'a file a level down').toBeDefined()
    await ui.press({ key: 'up' })

    await ui.press({ key: 'entry:README.md' })
    expect(await ui.find({ type: 'Code' }), 'the file, to read').toBeDefined()

    // Editing is typing in the file: a cursor, moved by the arrows, text put in where it stands.
    await ui.press({ key: 'edit' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.key({ key: 'down', in: 'editor' })
    await ui.key({ key: 'down', in: 'editor' })
    await ui.key({ key: 'end', in: 'editor' })
    await ui.key({ key: '!', in: 'editor' })
    await ui.key({ key: 'return', in: 'editor' })
    await ui.key({ key: 'x', in: 'editor' })
    await ui.key({ key: 'backspace', in: 'editor' })
    expect(disk['/work/app/README.md'], 'nothing is written until it is saved').toBe('# App\n\nold line\n')
    expect(JSON.stringify(await ui.drawn({ in: 'editor' })), 'the editor says so').toMatch(/unsaved/)
    // The way out now asks first: leaving would throw the changes away.
    expect(await ui.find({ key: 'discard-edit' }), 'a guarded way out').toBeDefined()
    await ui.key({ key: 's', ctrl: true, in: 'editor' })
    expect(disk['/work/app/README.md']).toBe('# App\n\nold line!\n\n')
    expect(await ui.find({ key: 'edit' }), 'saved: the plain way out again').toBeDefined()

    // ctrl+u goes back a change at a time (a terminal keeps ctrl+z for itself).
    await ui.key({ key: 'Q', in: 'editor' })
    await ui.key({ key: 'u', ctrl: true, in: 'editor' })
    await ui.key({ key: 's', ctrl: true, in: 'editor' })
    expect(disk['/work/app/README.md']).toBe('# App\n\nold line!\n\n')

    // Someone else wrote the file meanwhile: the editor's text is not written over theirs.
    await ui.key({ key: 'Z', in: 'editor' })
    disk['/work/app/README.md'] = '# Theirs\n'
    const before = written.length
    await ui.key({ key: 's', ctrl: true, in: 'editor' })
    expect(written.length, 'nothing written').toBe(before)
    expect(disk['/work/app/README.md']).toBe('# Theirs\n')
    expect(await ui.find({ type: 'Text', text: /changed on disk/ })).toBeDefined()
    await ui.press({ key: 'discard-edit' })
    await ui.press({ key: 'yes:discard-edit' })
    await ui.press({ key: 'back' })

    // Code being edited keeps its parts' colours, by the theme's own keys.
    await ui.press({ key: 'entry:src' })
    await ui.press({ key: 'entry:main.ts' })
    await ui.press({ key: 'edit' })
    expect(JSON.stringify(await ui.drawn({ in: 'editor' })), 'a keyword, coloured').toMatch(
      /"color":"permission"[^}]*\},"children":\["const"\]/,
    )
    await ui.press({ key: 'edit' })
    await ui.press({ key: 'back' })
    await ui.press({ key: 'up' })

    // The branch's runs, a failed one down to the step, and into the prompt.
    await ui.press({ key: 'section-actions' })
    expect(await ui.find({ key: 'run:92' }), 'a run under way').toBeDefined()
    await ui.press({ key: 'run:91' })
    expect(await ui.find({ type: 'Text', text: /failed at: Run npm test/ }), 'where it broke').toBeDefined()
    await ui.press({ key: 'run-again' })
    expect(ran, 'a failed run tries its failed jobs again').toContain('gh run rerun 91 --failed')
    await ui.press({ key: 'run-fix' })
    expect(filled.some(text => text.includes('gh run view 91 --log-failed'))).toBe(true)
    await ui.press({ key: 'back' })

    // A push reaches other people: the first press only asks.
    await ui.press({ key: 'section-changes' })
    await ui.press({ key: 'fetch' })
    expect(ran).toContain('git fetch --prune')
    expect(await ui.find({ key: 'pull' }), 'nothing to pull').toBeUndefined()
    const pushes = ran.filter(one => one === 'git push').length
    await ui.press({ key: 'push:/work/app' })
    expect(ran.filter(one => one === 'git push').length).toBe(pushes)
    await ui.press({ key: 'yes:push:/work/app' })
    expect(ran.filter(one => one === 'git push').length).toBe(pushes + 1)

    await ui.press({ key: 'section-files' })
    await ui.unmount()
  }
})

test('what is asked of Claude names the thing and never does it', () => {
  const repo = {
    root: '/work/app',
    name: 'app',
    branch: 'feat/parser',
    upstream: '',
    ahead: 0,
    behind: 0,
    files: [
      { path: 'src/parse.ts', index: 'M', workingTree: ' ' },
      { path: 'notes.txt', index: '?', workingTree: '?' },
    ],
  }
  const message = commitMessagePrompt(repo)
  expect(message).toMatch(/- src\/parse\.ts/)
  expect(message, 'only what is staged').not.toMatch(/notes\.txt/)
  expect(message).toMatch(/don't commit it yourself/)

  const tables = { database: 'app-db', tables: ['public.users'], note: '' }
  expect(queryPrompt(tables, 'postgres', false)).toMatch(/read-only\. Return a SELECT/)
  expect(queryPrompt(tables, 'postgres', true)).toMatch(/unlocked for writes/)

  // Several hooks share an event, and their commands are not kept: Claude is told to show them first.
  const hook = { name: 'PreToolUse', detail: 'project', scope: 'project', where: '/work/app/.claude/settings.json' }
  expect(removeToolPrompt('hooks', hook)).toMatch(/remove only the one I confirm/)
})

test('a search ranks a match in the name first and reads grep by its line numbers', () => {
  expect(matchNames(['docs/readme-notes/x.ts', 'README.md', 'node_modules/readme/a.js', 'src/a.ts'], 'readme')).toEqual([
    'README.md',
    'docs/readme-notes/x.ts',
  ])
  expect(parseGrep('./src/a.ts:12:  const url = "http://x:1"\nBinary file x matches\n', 'app/')).toEqual([
    { path: 'app/src/a.ts', line: 12, text: 'const url = "http://x:1"' },
  ])
})

test('a file in the browser carries its git letter, a folder says it holds changes, the rest a quiet tag', () => {
  const repos = [
    {
      root: '/work/app',
      name: 'app',
      branch: 'main',
      upstream: '',
      ahead: 0,
      behind: 0,
      files: [
        { path: 'src/parse.ts', index: ' ', workingTree: 'M' },
        { path: 'docs/new.md', index: 'A', workingTree: ' ' },
        { path: 'scratch/', index: '?', workingTree: '?' },
      ],
    },
  ]
  expect(statusOf(repos, '/work/app/src/parse.ts')).toBe('M')
  expect(statusOf(repos, '/work/app/docs/new.md'), 'staged alone').toBe('A')
  expect(statusOf(repos, '/work/app/src/other.ts')).toBe('')
  expect(statusOf(repos, '/elsewhere/src/parse.ts')).toBe('')

  expect(holdsChanges(repos, '/work/app/src')).toBe(true)
  expect(holdsChanges(repos, '/work/app/scratch'), 'untracked itself').toBe(true)
  expect(holdsChanges(repos, '/work/app/scratch/deep'), 'inside an untracked folder').toBe(true)
  expect(holdsChanges(repos, '/work/app/tests')).toBe(false)
  expect(holdsChanges(repos, '/work/app/sr'), 'a name that only starts the same').toBe(false)

  expect(tagOf('vitest.config.ts')).toBe('ts')
  expect(tagOf('README.md')).toBe('md')
  expect(tagOf('Makefile')).toBe('··')
  expect(tagOf('.gitignore'), 'a dotfile has no extension').toBe('··')
  expect(tagOf('a.c')).toBe('c ')
  // Two extensions never share a tag where the first two letters would: `.json` is not `.js`.
  expect([tagOf('a.js'), tagOf('a.json'), tagOf('a.jsx'), tagOf('a.ts'), tagOf('a.tsx'), tagOf('a.toml')]).toEqual([
    'js',
    '{}',
    'jx',
    'ts',
    'tx',
    'tm',
  ])
  expect([familyOf('a.ts'), familyOf('a.rs'), familyOf('README.md'), familyOf('Makefile')]).toEqual([
    'typed',
    'systems',
    'prose',
    'other',
  ])
})

test('a long line of a drawn diff breaks at a space or a mark, mid-word only where there is none', () => {
  expect(wrapLine('const answer = compute(first, second)', 20)).toEqual(['const answer = ', 'compute(first, ', 'second)'])
  expect(wrapLine('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  expect(wrapLine('short', 10)).toEqual(['short'])
  expect(wrapLine('', 10)).toEqual([''])
})

test('a line of code is told into its parts, and a comment left open runs on', () => {
  const kinds = (line: string, family: Parameters<typeof highlight>[1], inBlock = false) =>
    highlight(line, family, inBlock)
      .tokens.filter(token => token.kind !== 'plain')
      .map(token => `${token.kind}:${token.text}`)

  expect(kinds('export const total = sum(items, 42) // all of them', 'typed')).toEqual([
    'keyword:export',
    'keyword:const',
    'call:sum',
    'number:42',
    'comment:// all of them',
  ])
  expect(kinds("const name: UserName = 'it\\'s // not a comment'", 'typed')).toEqual([
    'keyword:const',
    'type:UserName',
    "string:'it\\'s // not a comment'",
  ])
  expect(kinds('pub fn main() -> Result<()> {', 'systems')).toEqual(['keyword:pub', 'keyword:fn', 'call:main', 'type:Result'])
  expect(kinds('def load(path):  # read it', 'python')).toEqual(['keyword:def', 'call:load', 'comment:# read it'])
  expect(kinds('"port": 4317, "ok": true', 'data')).toEqual(['string:"port"', 'number:4317', 'string:"ok"', 'keyword:true'])
  // An identifier with a digit in it is not a number; prose and the unknown are left alone.
  expect(kinds('h1 = x2 + 3', 'typed')).toEqual(['number:3'])
  expect(kinds('const is not a keyword here', 'prose')).toEqual([])
  expect([isHighlighted('typed'), isHighlighted('prose'), isHighlighted('other')]).toEqual([true, false, false])

  expect(highlight('  /* starts here', 'typed').inBlock).toBe(true)
  const closed = highlight('ends */ const a = 1', 'typed', true)
  expect(closed.inBlock).toBe(false)
  expect(closed.tokens[0]).toEqual({ text: 'ends */', kind: 'comment' })

  // A wrapped line keeps each part's colour on both rows.
  const { tokens } = highlight('const answer = 42', 'typed')
  expect(sliceTokens(tokens, 0, 8)).toEqual([
    { text: 'const', kind: 'keyword' },
    { text: ' an', kind: 'plain' },
  ])
  expect(sliceTokens(tokens, 8, 17).map(token => token.text).join('')).toBe('swer = 42')
})

test('keys edit a buffer as they do a file: typing, lines broken and joined, the cursor kept inside', () => {
  const type = (text: string, keys: Parameters<typeof applyKey>[1][], row = 0, col = 0) => {
    let buffer = bufferOf(text, row, col)
    for (const key of keys) buffer = applyKey(buffer, key, 10) ?? buffer

    return { text: textOf(buffer), at: [buffer.row, buffer.col] }
  }

  expect(type('ab', [{ key: 'right' }, { key: 'X' }])).toEqual({ text: 'aXb', at: [0, 2] })
  // Enter breaks the line and keeps its indent; Backspace at a line's start joins it back.
  expect(type('  ab', [{ key: 'end' }, { key: 'return' }, { key: 'c' }])).toEqual({ text: '  ab\n  c', at: [1, 3] })
  expect(type('a\nb', [{ key: 'down' }, { key: 'backspace' }])).toEqual({ text: 'ab', at: [0, 1] })
  expect(type('a\nb', [{ key: 'end' }, { key: 'delete' }])).toEqual({ text: 'ab', at: [0, 1] })
  // Left and right cross a line's end; nothing moves past the text.
  expect(type('a\nb', [{ key: 'right' }, { key: 'right' }]).at).toEqual([1, 0])
  expect(type('a\nb', [{ key: 'left' }, { key: 'up' }, { key: 'backspace' }])).toEqual({ text: 'a\nb', at: [0, 0] })
  expect(type('long line\nx', [{ key: 'end' }, { key: 'down' }]).at, 'a shorter line pulls the cursor in').toEqual([1, 1])
  // A paste comes as one key; a chord is not text, and Tab is two spaces.
  expect(type('', [{ key: 'one\r\ntwo' }])).toEqual({ text: 'one\ntwo', at: [1, 3] })
  expect(applyKey(bufferOf('a'), { key: 's', ctrl: true }, 10)).toBeUndefined()
  expect(type('', [{ key: 'tab' }, { key: 'space' }]).text).toBe('   ')

  expect([scrolled(0, 5, 10), scrolled(0, 10, 10), scrolled(8, 3, 10)]).toEqual([0, 1, 3])
})
