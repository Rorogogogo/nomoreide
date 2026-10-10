import { expect, mock, test } from 'claude-code/testing'

import { toActivity, toDatabases, toDbRows } from '../hooks/daemon'

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

const METRICS = {
  ok: true,
  metrics: {
    host: {
      current: {
        cpuPercent: 37.4,
        memoryUsedBytes: 12 * 1024 ** 3,
        memoryTotalBytes: 16 * 1024 ** 3,
        memoryUsedPercent: 75,
        loadAverage: [2.5, 2, 1.5],
        logicalCpuCount: 10,
        disk: { path: '/', usedPercent: 92.1, availableBytes: 40 * 1024 ** 3 },
      },
      samples: [],
    },
    services: { web: { service: 'web', cpuPercent: 3, rssMb: 210.5 } },
    systemProcesses: [
      { pid: 11, command: '/usr/local/bin/node server.js --token=SECRET', cpuPercent: 80, rssMb: 900, managedService: 'web' },
      { pid: 12, command: '/Applications/Some App.app/Contents/MacOS/Some App --key SECRET', cpuPercent: 5, rssMb: 50 },
    ],
  },
}

const CONNECTIONS = {
  ok: true,
  connections: [{ name: 'app-db', engine: 'postgres', url: 'postgres://u:SECRET@localhost/app', writeUnlocked: false }],
}

const ROWS = {
  ok: true,
  columns: [{ name: 'id' }, { name: 'email' }, { name: 'meta' }],
  rows: [
    { id: 1, email: 'a@example.com', meta: { plan: 'pro' } },
    { id: 2, email: null, meta: 'x'.repeat(500) },
  ],
  rowCount: 45,
}

test('activity names a process by its program, and a connection never carries its address', () => {
  const activity = toActivity(METRICS)

  expect(activity?.processes.map(one => one.name)).toEqual(['node', 'Some App'])
  expect(activity?.disk?.usedPercent).toBe(92.1)
  expect(JSON.stringify(activity)).not.toMatch(/SECRET/)
  expect(toActivity({ ok: true })).toBeUndefined()

  expect(toDatabases(CONNECTIONS)).toEqual([{ name: 'app-db', engine: 'postgres', isWritable: false }])

  const rows = toDbRows('app-db', 'public.users', 20, ROWS)
  expect(rows.rows[0]).toEqual(['1', 'a@example.com', '{"plan":"pro"}'])
  expect(rows.rows[1]?.[1]).toBe('null')
  expect(rows.rows[1]?.[2]?.length, 'a long cell is cut').toBe(201)
  expect(rows.rowCount).toBe(45)
})

test('the Services tab shows the machine and looks into a database, a page of rows at a time', async ($, on) => {
  const asked: string[] = []
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
    value: e.path.endsWith('daemon.json') ? '{"url":"http://127.0.0.1:4317"}' : 'ab'.repeat(32),
  }))
  on('http.fetch', (_$, e) => {
    const path = e.url.replace('http://127.0.0.1:4317', '')
    asked.push(`${e.init?.method ?? 'GET'} ${path}`)
    const body: unknown =
      path === '/api/services'
        ? { ok: true, services: [] }
        : path === '/api/status'
          ? { ok: true, status: { services: {} } }
          : path === '/api/errors?limit=50'
            ? { ok: true, incidents: [] }
            : path === '/api/metrics?includeProcesses=1'
              ? METRICS
              : path === '/api/databases'
                ? CONNECTIONS
                : path === '/api/databases/app-db/tables'
                  ? { ok: true, tables: [{ schema: 'public', name: 'users', qualifiedName: 'public.users' }] }
                  : path.startsWith('/api/databases/app-db/rows?table=public.users&limit=20&offset=')
                    ? ROWS
                    : path === '/api/databases/down-db/tables'
                      ? undefined
                      : undefined

    return {
      value: {
        status: body === undefined ? 500 : 200,
        ok: body !== undefined,
        headers: {},
        text: JSON.stringify(body ?? { ok: false, error: 'connection refused' }),
      },
    }
  })

  await $.command.run(typed('services'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.redraw()

    await ui.press({ key: 'section-activity' })
    expect(await ui.find({ type: 'Text', text: '92%' }), 'the disk, nearly full').toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'node' }), 'the busiest process').toBeDefined()
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/SECRET/)

    await ui.press({ key: 'section-database' })
    expect(await ui.find({ key: 'db:app-db' }), 'a connection').toBeDefined()
    expect(JSON.stringify(await ui.drawn()), 'never its address').not.toMatch(/SECRET/)
    await ui.press({ key: 'db:app-db' })
    await ui.press({ key: 'table:public.users' })
    expect(await ui.find({ type: 'Text', text: 'a@example.com' }), 'a cell').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rows 1–2 of 45/ })).toBeDefined()
    await ui.press({ key: 'page-on' })
    expect(asked).toContain('GET /api/databases/app-db/rows?table=public.users&limit=20&offset=2')
    await ui.press({ key: 'back' })
    await ui.press({ key: 'back' })

    // The pane reads and never writes: nothing but GETs went to the database routes.
    expect(asked.filter(one => one.includes('/api/databases') && !one.startsWith('GET '))).toEqual([])
    await ui.press({ key: 'section-services' })
    await ui.unmount()
  }
})
