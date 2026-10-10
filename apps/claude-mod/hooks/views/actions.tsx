import type { Color, RenderElement } from 'claude-code'

import type { OpenRun, Run, Runs } from '../../types'
import { standingOf } from '../github'
import { age } from '../text'
import { GLYPH } from '../tokens'
import type { Palette } from '../tokens'
import { MAX_ROWS, NARROW, chip, fit, group, heading, quiet, row, space } from './chrome'
import type { Actions, Kit, Model } from './model'

function toneOf(one: { status: string; conclusion: string }, colors: Palette): { glyph: string; color: Color } {
  const standing = standingOf(one)
  if (standing === 'passed') return { glyph: GLYPH.on, color: colors.ok }
  if (standing === 'failed') return { glyph: GLYPH.on, color: colors.bad }
  if (standing === 'running') return { glyph: GLYPH.on, color: colors.busy }

  return { glyph: GLYPH.off, color: colors.inert }
}

/** A run or a job in a word: how it ended, or that it has not. */
const wordOf = (one: { status: string; conclusion: string }): string =>
  (one.status === 'completed' ? one.conclusion || 'done' : one.status).replace(/_/g, ' ')

/** The branch's recent workflow runs, the newest first; a name opens its jobs. */
export function runsList(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const repo = m.repos.length === 1 ? m.repos[0] : m.repos.find(one => one.root === m.repo)
  if (repo === undefined) {
    return m.repos.length === 0
      ? quiet(kit, m, GLYPH.off, 'No git repository here', 'Workflow runs belong to a repository.')
      : quiet(kit, m, GLYPH.off, 'No repository in view', 'Open one under Changes; its runs are listed here.')
  }
  const runs = m.runs !== null && m.runs.root === repo.root && m.runs.branch === repo.branch ? m.runs : null
  if (runs === null) return quiet(kit, m, GLYPH.off, 'Asking GitHub', 'One moment.')
  if (runs.note !== '') return quiet(kit, m, GLYPH.off, 'No runs to show', runs.note)
  if (runs.items.length === 0) {
    return quiet(kit, m, GLYPH.off, `No workflow runs on ${repo.branch}`, 'Runs appear here once a workflow has run for this branch.')
  }

  return (
    <Box flexDirection="column">
      {heading(kit, `RUNS ON ${repo.branch.toUpperCase()}`, runs.items.length)}
      {group(kit, m, runs.items.slice(0, MAX_ROWS).map(run => {
        const word = wordOf(run)
        const mark = toneOf(run, m.colors)

        return row(
          kit,
          m,
          `row:run:${run.id}`,
          mark,
          <Button
            key={`run:${run.id}`}
            plain
            label={fit(m, run.title || run.workflow, word.length + 4)}
            onPress={() => act.openRun(run.id)}
          />,
          <Text color={mark.color}>{word}</Text>,
          [run.workflow, run.event, `${age(m.now, run.createdAt)} ago`].filter(part => part !== '').join(` ${GLYPH.dot} `),
        )
      }))}
    </Box>
  )
}

/** One run: its jobs, where a failed one broke, and the way to hand it to Claude. */
export function runView(kit: Kit, m: Model, runs: Runs, run: Run, open: OpenRun, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const mark = toneOf(run, m.colors)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={m.width < NARROW ? 1 : 2}>
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeRun()} />
        <Box flexGrow={1} />
        {run.url !== '' && (
          <Button key="run-web" {...chip(m)} hotkey="o" label="open" onPress={() => act.openUrl(run.url)} />
        )}
        {run.status === 'completed' && (
          <Button key="run-again" {...chip(m)} hotkey="r" label="re-run" onPress={() => act.rerun(run.id)} />
        )}
        {standingOf(run) === 'failed' && (
          <Button key="run-fix" {...chip(m, false)} hotkey="f" label="fix with Claude" onPress={() => act.runToPrompt(run.id)} />
        )}
      </Box>
      {space(kit)}
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexShrink={0} marginRight={1}>
          <Text color={mark.color}>{mark.glyph}</Text>
        </Box>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text bold wrap="truncate-end">
            {fit(m, run.title || run.workflow, 4)}
          </Text>
          <Text dimColor wrap="truncate-end">
            {[run.workflow, runs.branch, wordOf(run), `${age(m.now, run.createdAt)} ago`]
              .filter(part => part !== '')
              .join(` ${GLYPH.dot} `)}
          </Text>
        </Box>
      </Box>
      {space(kit)}
      {open.jobs.length === 0 ? (
        <Text dimColor>GitHub listed no jobs for this run.</Text>
      ) : (
        heading(kit, 'JOBS', open.jobs.length)
      )}
      {open.jobs.length > 0 &&
        group(kit, m, open.jobs.map((job, at) => {
          const tone = toneOf(job, m.colors)
          const word = wordOf(job)

          return row(
            kit,
            m,
            `row:job:${at}`,
            tone,
            <Text bold wrap="truncate-end">
              {fit(m, job.name, word.length + 4)}
            </Text>,
            <Text color={tone.color}>{word}</Text>,
            job.failedStep === '' ? '' : `failed at: ${job.failedStep}`,
            false,
          )
        }))}
    </Box>
  )
}
