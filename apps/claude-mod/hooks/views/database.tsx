import type { RenderElement } from 'claude-code'

import type { DbRows, DbTables } from '../../types'
import { clipEnd } from '../text'
import { GLYPH } from '../tokens'
import { MAX_ROWS, NARROW, chip, fit, group, heading, more, quiet, row, rowHover, space } from './chrome'
import type { Actions, Kit, Model } from './model'

/** How many of a row's columns are shown; a wide table's rest is in the dashboard. */
const MAX_COLUMNS = 14

/** The registered connections. Reading only: changing rows stays in the dashboard, behind its unlock. */
export function databaseList(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  if (m.databases.length === 0) {
    return quiet(kit, m, GLYPH.off, 'No databases registered', 'Add a connection in NoMoreIDE to look into it from here.')
  }

  return (
    <Box flexDirection="column">
      {heading(kit, 'CONNECTIONS', m.databases.length)}
      {group(kit, m, m.databases.map(one =>
        row(
          kit,
          m,
          `row:db:${one.name}`,
          { glyph: GLYPH.off, color: m.colors.inert },
          <Button key={`db:${one.name}`} plain label={fit(m, one.name, 14)} onPress={() => act.openDatabase(one.name)} />,
          one.isWritable && <Text color={m.colors.busy}>writes unlocked</Text>,
          one.engine,
        ),
      ))}
    </Box>
  )
}

export function tablesView(kit: Kit, m: Model, tables: DbTables, act: Actions): RenderElement {
  const { Box, Text, Button } = kit

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeDatabase()} />
      </Box>
      {space(kit)}
      <Text bold wrap="truncate-end">
        {fit(m, tables.database, 2)}
      </Text>
      {space(kit)}
      {tables.note !== '' && <Text color={m.colors.bad}>{clipEnd(tables.note, 400)}</Text>}
      {tables.note === '' && tables.tables.length === 0 && <Text dimColor>No tables in this database.</Text>}
      {tables.tables.length > 0 && heading(kit, 'TABLES', tables.tables.length)}
      {tables.tables.length > 0 &&
        group(kit, m, tables.tables.slice(0, MAX_ROWS).map(name => (
          <Box key={`row:table:${name}`} flexDirection="row" {...rowHover(m)}>
            <Button
              key={`table:${name}`}
              plain
              label={fit(m, name, 2)}
              onPress={() => act.openTable(tables.database, name, 0)}
            />
          </Box>
        )), 0)}
      {more(kit, tables.tables.length - MAX_ROWS, 'tables')}
    </Box>
  )
}

/** A page of rows. A pane is too narrow for a grid, so each row is a card of `column  value` lines. */
export function rowsView(kit: Kit, m: Model, rows: DbRows, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const size = Math.max(1, rows.rows.length)
  const last = rows.offset + rows.rows.length
  const columns = rows.columns.slice(0, MAX_COLUMNS)
  const widest = Math.min(m.width < NARROW ? 12 : 20, Math.max(0, ...columns.map(name => name.length)))
  const gap = m.width < NARROW ? 1 : 2

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={gap}>
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeTable()} />
        <Box flexGrow={1} />
        {rows.offset > 0 && (
          <Button
            key="page-back"
            {...chip(m)}
            hotkey="k"
            label="earlier"
            onPress={() => act.openTable(rows.database, rows.table, rows.offset - size)}
          />
        )}
        {last < rows.rowCount && (
          <Button
            key="page-on"
            {...chip(m)}
            hotkey="j"
            label="later"
            onPress={() => act.openTable(rows.database, rows.table, last)}
          />
        )}
      </Box>
      {space(kit)}
      <Text bold wrap="truncate-end">
        {fit(m, rows.table, 2)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {[
          rows.database,
          rows.rows.length === 0 ? '' : `rows ${rows.offset + 1}${GLYPH.dash}${last} of ${rows.rowCount}`,
          rows.columns.length > MAX_COLUMNS ? `${MAX_COLUMNS} of ${rows.columns.length} columns` : '',
        ]
          .filter(part => part !== '')
          .join(` ${GLYPH.dot} `)}
      </Text>
      {space(kit)}
      {rows.note !== '' && <Text color={m.colors.bad}>{clipEnd(rows.note, 400)}</Text>}
      {rows.note === '' && rows.rows.length === 0 && <Text dimColor>No rows.</Text>}
      {rows.rows.map((cells, at) => (
        <Box key={`row:record:${at}`} flexDirection="column" marginBottom={m.isTerminal ? 0 : 0}>
          {group(kit, m, columns.map((name, column) => (
            <Box key={`cell:${at}:${column}`} flexDirection="row">
              <Box flexShrink={0} width={widest + 2}>
                <Text dimColor wrap="truncate-end">
                  {clipEnd(name, widest)}
                </Text>
              </Box>
              <Box flexShrink={1} minWidth={0}>
                <Text wrap="truncate-end">{cells[column] ?? ''}</Text>
              </Box>
            </Box>
          )), 0)}
        </Box>
      ))}
    </Box>
  )
}
