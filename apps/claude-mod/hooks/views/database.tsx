import type { RenderElement } from 'claude-code'

import type { DbRows, DbTables } from '../../types'
import { databasePrompt, namedTablePrompt, queryPrompt, rowPrompt, tablePrompt } from '../prompts'
import { clipEnd } from '../text'
import { GLYPH } from '../tokens'
import { brandOfEngine } from '../brands'
import {
  brand,
  CARD,
  MAX_ROWS,
  NARROW,
  ask,
  chip,
  fit,
  group,
  heading,
  kind,
  more,
  quiet,
  rowHover,
  space,
} from './chrome'
import type { Actions, Kit, Model } from './model'

const engineOf = (m: Model, name: string): string => m.databases.find(one => one.name === name)?.engine ?? ''

const isWritable = (m: Model, name: string): boolean => m.databases.find(one => one.name === name)?.isWritable === true

/** The registered connections. Reading only: changing rows stays in the dashboard, behind its unlock. */
export function databaseList(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  if (m.databases.length === 0) {
    return quiet(kit, m, GLYPH.off, 'No databases registered', 'Add a connection in NoMoreIDE to look into it from here.')
  }

  return (
    <Box flexDirection="column">
      {heading(kit, 'CONNECTIONS', m.databases.length)}
      {group(kit, m, m.databases.map(one => (
        <Box key={`row:db:${one.name}`} flexDirection="row" alignItems="center" {...rowHover(m)}>
          {brand(kit, m, brandOfEngine(one.engine), 'database')}
          <Box flexShrink={1} minWidth={0}>
            <Button key={`db:${one.name}`} plain label={fit(m, one.name, 24)} onPress={() => act.openDatabase(one.name)} />
          </Box>
          <Box flexGrow={1} />
          <Box flexShrink={0} flexDirection="row" alignItems="center" columnGap={m.width < NARROW ? 1 : 2} marginLeft={1}>
            {one.isWritable ? (
              <Text color={m.colors.busy}>writes unlocked</Text>
            ) : (
              m.width >= NARROW + 20 && <Text dimColor>{one.engine}</Text>
            )}
            {ask(kit, m, act, `ask-db:${one.name}`, 'ask', () => databasePrompt(one))}
          </Box>
        </Box>
      )), 0)}
    </Box>
  )
}

/** The pane's one-line field for a statement: read-only, answered as a table. */
function queryField(kit: Kit, database: string, act: Actions, sql = ''): RenderElement | false {
  const { Input } = kit

  return (
    Input !== undefined && (
      <Input
        key="sql"
        label="sql"
        placeholder="select … (read-only)"
        {...(sql === '' ? {} : { value: sql })}
        submitLabel="run"
        onSubmit={statement => act.runQuery(database, statement)}
      />
    )
  )
}

export function tablesView(kit: Kit, m: Model, tables: DbTables, act: Actions): RenderElement {
  const { Box, Text, Button } = kit

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeDatabase()} />
        <Box flexGrow={1} />
        {tables.note === '' && ask(kit, m, act, 'ask-query', 'write a query', () => queryPrompt(tables, engineOf(m, tables.database), isWritable(m, tables.database)))}
      </Box>
      {space(kit)}
      <Text bold wrap="truncate-end">
        {fit(m, tables.database, 2)}
      </Text>
      {space(kit)}
      {tables.note === '' && queryField(kit, tables.database, act)}
      {tables.note === '' && space(kit)}
      {tables.note !== '' && <Text color={m.colors.bad}>{clipEnd(tables.note, 400)}</Text>}
      {tables.note === '' && tables.tables.length === 0 && <Text dimColor>No tables in this database.</Text>}
      {tables.tables.length > 0 && heading(kit, 'TABLES', tables.tables.length)}
      {tables.tables.length > 0 &&
        group(kit, m, tables.tables.slice(0, MAX_ROWS).map(name => (
          <Box key={`row:table:${name}`} flexDirection="row" alignItems="center" {...rowHover(m)}>
            {kind(kit, m, 'table')}
            <Box flexShrink={1} minWidth={0}>
              <Button
                key={`table:${name}`}
                plain
                label={fit(m, name, 14)}
                onPress={() => act.openTable(tables.database, name, 0)}
              />
            </Box>
            <Box flexGrow={1} />
            <Box flexShrink={0} marginLeft={1}>
              {ask(kit, m, act, `ask-table:${name}`, 'ask', () =>
                namedTablePrompt(tables.database, engineOf(m, tables.database), name),
              )}
            </Box>
          </Box>
        )), 0)}
      {more(kit, tables.tables.length - MAX_ROWS, 'tables')}
    </Box>
  )
}

/** The widest a column is drawn, and the narrowest, in cells. */
const MAX_COLUMN = 24
const MIN_COLUMN = 4
/** The air between two columns. */
const GUTTER = 2

/**
 * A page of rows as a table: columns across, rows down. A pane is narrow, so
 * only the columns that fit are drawn and the rest are a press away; a row's
 * first cell opens the row, to be read whole.
 */
export function rowsView(kit: Kit, m: Model, rows: DbRows, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const opened = rows.record === null ? undefined : rows.rows[rows.record]
  if (opened !== undefined && rows.record !== null) return recordView(kit, m, rows, rows.record, opened, act)

  const last = rows.offset + rows.rows.length
  const gap = m.width < NARROW ? 1 : 2
  // Each column is as wide as what it holds on this page, within limits.
  const widths = rows.columns.map((name, column) =>
    Math.max(
      MIN_COLUMN,
      Math.min(MAX_COLUMN, Math.max(name.length, ...rows.rows.map(cells => (cells[column] ?? '').length))),
    ),
  )
  const room = Math.max(MIN_COLUMN + GUTTER, m.width - CARD)
  const first = Math.min(rows.firstColumn, Math.max(0, rows.columns.length - 1))
  let end = first
  let used = 0
  while (end < rows.columns.length && (end === first || used + (widths[end] ?? 0) + GUTTER <= room)) {
    used += (widths[end] ?? 0) + GUTTER
    end += 1
  }
  const shown = rows.columns.slice(first, end).map((name, at) => ({ name, at: first + at, width: widths[first + at] ?? MIN_COLUMN }))
  const cell = (key: string, width: number, content: RenderElement): RenderElement => (
    <Box key={key} flexShrink={0} width={width + GUTTER}>
      {content}
    </Box>
  )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={gap}>
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeTable()} />
        <Box flexGrow={1} />
        {rows.note === '' &&
          rows.sql === '' &&
          ask(kit, m, act, 'ask-rows', 'ask', () => tablePrompt(rows, engineOf(m, rows.database)))}
        {rows.sql === '' && rows.offset > 0 && (
          <Button
            key="page-back"
            {...chip(m)}
            hotkey="k"
            label="earlier"
            onPress={() => act.openTable(rows.database, rows.table, rows.offset - Math.max(1, rows.rows.length))}
          />
        )}
        {rows.sql === '' && rows.hasMore && (
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
        {rows.sql === '' ? fit(m, rows.table, 2) : 'Query'}
      </Text>
      <Text dimColor wrap="truncate-end">
        {[
          rows.database,
          rows.rows.length === 0
            ? ''
            : rows.sql !== ''
              ? `${rows.rows.length} row${rows.rows.length === 1 ? '' : 's'}${rows.hasMore ? ', and more not shown' : ''}`
              : `rows ${rows.offset + 1}${GLYPH.dash}${last}${rows.total === null ? '' : ` of ${rows.total}`}`,
        ]
          .filter(part => part !== '')
          .join(` ${GLYPH.dot} `)}
      </Text>
      {shown.length < rows.columns.length && (
        <Box flexDirection="row" alignItems="center" columnGap={gap} marginTop={m.isTerminal ? 0 : 1}>
          <Text dimColor>
            columns {first + 1}
            {GLYPH.dash}
            {end} of {rows.columns.length}
          </Text>
          <Box flexGrow={1} />
          {first > 0 && (
            <Button
              key="columns-back"
              {...chip(m)}
              hotkey="h"
              label="‹ columns"
              onPress={() => act.shiftColumns(first - Math.max(1, shown.length))}
            />
          )}
          {end < rows.columns.length && (
            <Button key="columns-on" {...chip(m)} hotkey="l" label="columns ›" onPress={() => act.shiftColumns(end)} />
          )}
        </Box>
      )}
      {rows.sql !== '' && space(kit)}
      {rows.sql !== '' && queryField(kit, rows.database, act, rows.sql)}
      {space(kit)}
      {rows.note !== '' && <Text color={m.colors.bad}>{clipEnd(rows.note, 400)}</Text>}
      {rows.note === '' && rows.rows.length === 0 && <Text dimColor>No rows.</Text>}
      {rows.rows.length > 0 &&
        group(
          kit,
          m,
          [
            <Box key="row:head" flexDirection="row">
              {shown.map(column =>
                cell(
                  `head:${column.at}`,
                  column.width,
                  <Text bold dimColor wrap="truncate-end">
                    {clipEnd(column.name, column.width)}
                  </Text>,
                ),
              )}
            </Box>,
            ...rows.rows.map((cells, at) => (
              <Box key={`row:record:${at}`} flexDirection="row" {...rowHover(m)}>
                {shown.map((column, place) => {
                  const value = cells[column.at] ?? ''

                  return cell(
                    `cell:${at}:${column.at}`,
                    column.width,
                    place === 0 ? (
                      <Button
                        key={`record:${at}`}
                        plain
                        dimColor={value === 'null'}
                        label={clipEnd(value, column.width) || ' '}
                        onPress={() => act.openRecord(at)}
                      />
                    ) : (
                      <Text dimColor={value === 'null'} wrap="truncate-end">
                        {clipEnd(value, column.width)}
                      </Text>
                    ),
                  )
                })}
              </Box>
            )),
          ],
          0,
        )}
    </Box>
  )
}

/** One row, every column of it: the name beside the whole value. */
function recordView(
  kit: Kit,
  m: Model,
  rows: DbRows,
  index: number,
  cells: readonly string[],
  act: Actions,
): RenderElement {
  const { Box, Text, Button } = kit
  const widest = Math.min(m.width < NARROW ? 12 : 22, Math.max(0, ...rows.columns.map(name => name.length)))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={m.width < NARROW ? 1 : 2}>
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.openRecord(null)} />
        <Box flexGrow={1} />
        {ask(kit, m, act, 'ask-row', 'ask', () => rowPrompt(rows, engineOf(m, rows.database), index))}
        {index > 0 && <Button key="record-back" {...chip(m)} hotkey="k" label="previous" onPress={() => act.openRecord(index - 1)} />}
        {index < rows.rows.length - 1 && (
          <Button key="record-on" {...chip(m)} hotkey="j" label="next" onPress={() => act.openRecord(index + 1)} />
        )}
      </Box>
      {space(kit)}
      <Text bold wrap="truncate-end">
        {rows.sql === '' ? fit(m, rows.table, 2) : 'Query'}
      </Text>
      <Text dimColor>row {rows.offset + index + 1}</Text>
      {space(kit)}
      {group(kit, m, rows.columns.map((name, column) => (
        <Box key={`field:${column}`} flexDirection="row" alignItems="flex-start">
          <Box flexShrink={0} width={widest + GUTTER}>
            <Text dimColor wrap="truncate-end">
              {clipEnd(name, widest)}
            </Text>
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor={cells[column] === 'null'}>{cells[column] ?? ''}</Text>
          </Box>
        </Box>
      )), 0)}
    </Box>
  )
}
