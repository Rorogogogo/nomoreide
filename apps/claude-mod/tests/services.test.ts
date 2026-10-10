import { expect, mock, test } from 'claude-code/testing'

import { countSql, fromJsonRows, jsonSql, pageSql, thin, toActivity, toDatabases, toDbRows, toServiceTrend, toTrend } from '../hooks/daemon'
import { trendSvg } from '../hooks/icons'
import { plot, runs, spark } from '../hooks/views/usage'

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
  columns: [{ name: 'id', primaryKey: true }, { name: 'email' }, { name: 'meta' }],
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

  const rows = toDbRows('app-db', 'public.users', 20, ROWS, 20, 45)
  expect(rows.rows[0]).toEqual(['1', 'a@example.com', '{"plan":"pro"}'])
  expect(rows.rows[1]?.[1]).toBe('null')
  expect(rows.rows[1]?.[2]?.length, 'a long cell is cut').toBe(201)
  expect(rows.total).toBe(45)
  expect(rows.hasMore, 'rows 21 and 22 of 45').toBe(true)
  // With no count, a full page is taken to have more behind it.
  expect(toDbRows('app-db', 't', 0, ROWS, 2).hasMore).toBe(true)
  expect(toDbRows('app-db', 't', 0, ROWS, 20).hasMore).toBe(false)

  // The statement is a read with every name quoted: a name cannot end its quoting.
  const columns = [
    { name: 'id', isKey: true },
    { name: 'we"ird', isKey: false },
  ]
  expect(pageSql('public.us"ers', columns, 20, 40)).toBe(
    'SELECT "id"::text AS "id", "we""ird"::text AS "we""ird" FROM "public"."us""ers" ORDER BY "id" LIMIT 20 OFFSET 40',
  )
  expect(countSql('public.users')).toBe('SELECT count(*)::text AS "n" FROM "public"."users"')

  // A typed query is asked for as JSON so its values come back written out, in its own column order.
  expect(jsonSql('select b, a from t;')).toBe('SELECT row_to_json("q")::text AS "j" FROM (select b, a from t) AS "q"')
  expect(jsonSql('show server_version')).toBeUndefined()
  expect(jsonSql('select 1; delete from t')).toBeUndefined()
  expect(fromJsonRows({ rows: [{ j: '{"b":"2026-03-29T08:01:59+00:00","a":null}' }] })).toEqual({
    columns: ['b', 'a'],
    rows: [{ b: '2026-03-29T08:01:59+00:00', a: null }],
  })
  expect(fromJsonRows({ rows: [{ id: 1 }] }), 'not that shape').toBeUndefined()
})

test('the Services tab shows the machine and looks into a database, a page of rows at a time', async ($, on) => {
  const asked: string[] = []
  const queried: string[] = []
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
    value: e.path.endsWith('daemon.json') ? '{"url":"http://127.0.0.1:4317"}' : 'ab'.repeat(32),
  }))
  on('http.fetch', (_$, e) => {
    const path = e.url.replace('http://127.0.0.1:4317', '')
    asked.push(`${e.init?.method ?? 'GET'} ${path}`)
    const sql = typeof e.init?.body === 'string' ? decodeURIComponent(e.init.body.split('&')[0]?.slice(4) ?? '') : ''
    if (sql !== '') queried.push(sql)
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
                  : path === '/api/databases/app-db/rows?table=public.users&limit=1&offset=0'
                    ? ROWS
                    : path === '/api/databases/app-db/query' && sql.includes('count(*)')
                      ? { ok: true, columns: ['n'], rows: [{ n: '45' }] }
                      : path === '/api/databases/app-db/query'
                        ? {
                            ok: true,
                            columns: ['id', 'email', 'meta'],
                            rows: [
                              { id: '1', email: 'a@example.com', meta: '{"plan": "pro"}' },
                              { id: '2', email: null, meta: 'x' },
                            ],
                          }
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

  on('prompt.fill', (_$, e) => {
    filled.push(e.text)

    return { isFilled: true }
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
    // Every thing in the view can be asked about: the question is drafted, with what it is about.
    await ui.press({ key: 'ask-db:app-db' })
    expect(filled.at(-1)).toMatch(/^I'm looking at my postgres database \(connection "app-db"\)\./)
    await ui.press({ key: 'db:app-db' })
    await ui.press({ key: 'ask-table:public.users' })
    expect(filled.at(-1)).toMatch(/the table `public\.users` in my postgres database/)
    await ui.press({ key: 'table:public.users' })
    // A table: column names across the top, a row's cells beside each other.
    expect(await ui.find({ type: 'Text', text: 'email' }), 'a column heading').toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'a@example.com' }), 'a cell').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rows 1–2 of 45/ })).toBeDefined()
    // A row's first cell opens the row, every column of it.
    await ui.press({ key: 'record:0' })
    await ui.press({ key: 'ask-row' })
    expect(filled.at(-1)).toMatch(/email: a@example\.com/)
    expect(filled.join('\n'), 'never the connection address').not.toMatch(/SECRET/)
    expect(await ui.find({ type: 'Text', text: '{"plan": "pro"}' }), 'the whole value').toBeDefined()
    await ui.press({ key: 'record-on' })
    await ui.press({ key: 'back' })
    await ui.press({ key: 'page-on' })
    expect(queried.at(-2) ?? '', 'the next page, by the primary key').toMatch(/ORDER BY "id" LIMIT 20 OFFSET 2$/)
    await ui.press({ key: 'back' })

    // A statement typed into the pane goes to the daemon's read-only route and comes back as a table.
    await ui.input({ key: 'sql', text: 'SELECT id, email FROM users' })
    expect(queried, 'asked for as JSON first, then as typed').toContain(
      'SELECT row_to_json("q")::text AS "j" FROM (SELECT id, email FROM users) AS "q"',
    )
    expect(queried.at(-1)).toBe('SELECT id, email FROM users')
    expect(asked.at(-1)).toBe('POST /api/databases/app-db/query')
    expect(await ui.find({ type: 'Text', text: 'Query' }), 'its result').toBeDefined()
    expect(await ui.find({ key: 'record:1' }), 'a row of it').toBeDefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'back' })

    // Rows only ever go through the two read routes: nothing reaches the ones that write.
    expect(queried.length).toBeGreaterThan(0)
    expect(asked.filter(one => /\/(execute|write-access|rows\/delete)/.test(one))).toEqual([])
    await ui.press({ key: 'section-services' })
    await ui.unmount()
  }
})

test('samples become a trend: thinned, timed, and a row of blocks on a cell grid', () => {
  expect(thin([1, 3, 5, 7], 2), 'each the mean of its stretch').toEqual([2, 6])
  expect(thin([1, 2], 60), 'few enough already').toEqual([1, 2])
  const samples = [
    { t: 1_000, cpuPercent: 10, memoryUsedPercent: 50 },
    { t: 4_000, cpuPercent: 30, memoryUsedPercent: 60 },
    { t: 7_000, cpuPercent: 90, memoryUsedPercent: 70 },
  ]
  expect(toTrend(samples, 'cpuPercent', 'memoryUsedPercent')).toEqual({ cpu: [10, 30, 90], memory: [50, 60, 70], seconds: 6 })
  expect(toTrend(samples.slice(0, 1), 'cpuPercent', 'memoryUsedPercent'), 'one sample is no line').toBeNull()
  expect(toServiceTrend({ metrics: { samples: [{ t: 0, cpu: 1, rss: 100 }, { t: 3_000, cpu: 2, rss: 120 }] } })).toEqual({
    cpu: [1, 2],
    memory: [100, 120],
    seconds: 3,
  })
  expect(spark([0, 50, 100], 100)).toBe('▁▅█')
  // A line from the foot to the top of a plot two cells by two: every row marked, the last dot at the top.
  const grid = plot([{ values: [0, 100], top: 100 }], 2, 2)
  expect(grid.every(row => row.some(cell => cell.bits !== 0)), 'the climb is joined, row to row').toBe(true)
  expect(grid[0]?.[1]?.bits ?? 0, 'the top right dot').toBeGreaterThan(0)
  expect(grid[1]?.[0]?.owner, 'owned by the series that drew it').toBe(1)
  expect(runs([{ bits: 0, owner: 0 }, { bits: 1, owner: 1 }, { bits: 8, owner: 1 }]).map(run => run.owner)).toEqual([0, 1])
  expect(trendSvg('dark', [{ values: [0, 100], top: 100, color: '#10B981' }], 80, 20), 'a line from the foot to the top').toContain(
    'd="M0.0 18.0L78.0 2.0"',
  )
  const marked = trendSvg('dark', [{ values: [0, 100], top: 100, color: '#10B981' }], 200, 80, {
    left: ['100%', '50%', '0%'],
    foot: ['30m ago', '15m ago', 'now'],
  })
  for (const mark of ['100%', '50%', '0%', '30m ago', '15m ago', 'now']) expect(marked, `the axis says ${mark}`).toContain(`>${mark}</text>`)
})
