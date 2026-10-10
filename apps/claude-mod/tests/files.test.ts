import { expect, mock, test } from 'claude-code/testing'

import { applyEdit, isUnder, linesOf, sortEntries, windowFor } from '../hooks/files'
import { parseJobs, parseRuns, standingOf, toRunPrompt } from '../hooks/github'

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

    // Folders open, `.git` is not offered, and the way back up appears a level down.
    expect(await ui.find({ key: 'entry:.git' })).toBeUndefined()
    await ui.press({ key: 'entry:src' })
    expect(await ui.find({ key: 'entry:main.ts' }), 'a file a level down').toBeDefined()
    await ui.press({ key: 'up' })

    await ui.press({ key: 'entry:README.md' })
    expect(await ui.find({ type: 'Code' }), 'the file, to read').toBeDefined()

    // Editing: lines take a press, the pressed one opens in the text field.
    await ui.press({ key: 'edit' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.press({ key: 'line:3' })
    await ui.input({ key: 'line-text:3', text: 'new line' })
    expect(disk['/work/app/README.md']).toBe('# App\n\nnew line\n')

    await ui.press({ key: 'line:1' })
    await ui.press({ key: 'line-insert' })
    expect(disk['/work/app/README.md']).toBe('# App\n\n\nnew line\n')
    expect(await ui.find({ key: 'line-text:2' }), 'the new line, open for typing').toBeDefined()
    await ui.press({ key: 'line-delete' })
    expect(disk['/work/app/README.md']).toBe('# App\n\nnew line\n')

    // Someone else wrote the file meanwhile: the pane's copy is not written over theirs.
    await ui.press({ key: 'line:1' })
    disk['/work/app/README.md'] = '# Theirs\n\nnew line\n'
    const before = written.length
    await ui.input({ key: 'line-text:1', text: '# Mine' })
    expect(written.length, 'nothing written').toBe(before)
    expect(disk['/work/app/README.md']).toBe('# Theirs\n\nnew line\n')
    expect(await ui.find({ type: 'Text', text: /changed on disk/ })).toBeDefined()

    await ui.press({ key: 'edit' })
    await ui.press({ key: 'back' })

    // The branch's runs, a failed one down to the step, and into the prompt.
    await ui.press({ key: 'section-actions' })
    expect(await ui.find({ key: 'run:92' }), 'a run under way').toBeDefined()
    await ui.press({ key: 'run:91' })
    expect(await ui.find({ type: 'Text', text: /failed at: Run npm test/ }), 'where it broke').toBeDefined()
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
