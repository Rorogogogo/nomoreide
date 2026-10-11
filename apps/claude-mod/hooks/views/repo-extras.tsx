import type { RenderElement } from 'claude-code'

import type { Repo } from '../../types'
import { createPullPrompt, reviewPullPrompt } from '../prompts'
import { age, clipEnd } from '../text'
import { GLYPH } from '../tokens'
import {
  NARROW,
  ask,
  chip,
  fit,
  group,
  heading,
  more,
  repoNameOf,
  row,
  space,
  twice,
} from './chrome'
import type { Actions, Kit, Model } from './model'

/** How many checkpoints the Git view lists; the dashboard holds the rest. */
export const MAX_SNAPSHOTS = 5

/** The branch's pull request and how its checks stand; nothing for a branch without one. */
export function pullRow(kit: Kit, m: Model, repo: Repo, act: Actions): RenderElement | false {
  const { Box, Text, Button } = kit
  const pull = m.pulls.find(one => one.root === repo.root)
  if (pull === undefined) return false
  const isOpen = pull.state === 'OPEN'
  const tone =
    pull.state === 'MERGED'
      ? m.colors.merged
      : !isOpen || pull.checks === 'none'
        ? m.colors.inert
        : pull.checks === 'failing'
          ? m.colors.bad
          : pull.checks === 'running'
            ? m.colors.busy
            : m.colors.ok
  const word = !isOpen ? pull.state.toLowerCase() : pull.checks === 'none' ? 'no checks' : `checks ${pull.checks}`
  const meta = [
    'pull request',
    pull.isDraft ? 'draft' : '',
    pull.total > 0 ? `${pull.passed}/${pull.total} checks passed` : '',
  ]
    .filter(part => part !== '')
    .join(` ${GLYPH.dot} `)

  return group(kit, m, [
    row(
      kit,
      m,
      'row:pull',
      { glyph: GLYPH.on, color: tone },
      <Button
        key="pull"
        plain
        label={fit(m, `#${pull.number} ${pull.title}`, word.length + 16)}
        onPress={() => act.openUrl(pull.url)}
      />,
      <Box flexDirection="row" alignItems="center" columnGap={m.width < NARROW ? 1 : 2}>
        <Text color={tone}>{word}</Text>
        {isOpen && m.width >= NARROW && ask(kit, m, act, 'ask-review', 'review', () => reviewPullPrompt(pull))}
      </Box>,
      meta,
    ),
  ])
}

/** NoMoreIDE's checkpoints of this repository, where it is the one the daemon has selected. */
export function snapshotList(kit: Kit, m: Model, repo: Repo, act: Actions): RenderElement | false {
  const { Box, Text, Button } = kit
  if (m.reach !== 'up' || m.snapshots === null) return false
  // The daemon checkpoints the repository selected in it, and no other: said
  // here, so a section that is missing is not a puzzle.
  if (m.snapshots.root !== repo.root) {
    return (
      <Box flexDirection="column">
        {space(kit)}
        <Text dimColor>
          Snapshots follow the repository selected in NoMoreIDE, now {clipEnd(repoNameOf(m.snapshots.root), 40)}.
        </Text>
      </Box>
    )
  }
  const items = m.snapshots.items

  return (
    <Box flexDirection="column">
      {space(kit)}
      {heading(
        kit,
        'SNAPSHOTS',
        items.length,
        <Button key="snapshot" {...chip(m)} label="take" onPress={() => act.takeSnapshot(repo.root)} />,
      )}
      {items.length > 0 &&
        group(kit, m, items.slice(0, MAX_SNAPSHOTS).map(one =>
          row(
            kit,
            m,
            `row:snap:${one.sha}`,
            { glyph: GLYPH.off, color: m.colors.inert },
            <Text bold wrap="truncate-end">
              {fit(m, one.label || one.sha.slice(0, 7), 18)}
            </Text>,
            twice(kit, m, act, `restore:${one.sha}`, 'restore', () => act.restoreSnapshot(repo.root, one.sha)),
            `${one.sha.slice(0, 7)} ${GLYPH.dot} ${age(m.now, one.createdAt)} ago`,
            false,
          ),
        ))}
      {more(kit, items.length - MAX_SNAPSHOTS, 'in the dashboard')}
    </Box>
  )
}

/**
 * How the branch stands against its upstream, and the three ways to move
 * it. A push reaches other people, so it is taken in two presses.
 */
export function syncRow(kit: Kit, m: Model, repo: Repo, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const standing =
    repo.upstream === ''
      ? 'no upstream'
      : repo.ahead === 0 && repo.behind === 0
        ? 'up to date'
        : [repo.ahead > 0 ? `${repo.ahead} to push` : '', repo.behind > 0 ? `${repo.behind} to pull` : '']
            .filter(part => part !== '')
            .join(` ${GLYPH.dot} `)

  return (
    <Box flexDirection="row" alignItems="center" columnGap={m.width < NARROW ? 1 : 2}>
      <Box flexShrink={1} minWidth={0}>
        <Text dimColor wrap="truncate-end">
          {standing}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Button key="fetch" {...chip(m)} label="fetch" onPress={() => act.sync(repo.root, 'fetch')} />
      {repo.behind > 0 && (
        <Button key="pull" {...chip(m, false)} label="pull" onPress={() => act.sync(repo.root, 'pull')} />
      )}
      {m.pulls.every(one => one.root !== repo.root) &&
        !['main', 'master', 'detached'].includes(repo.branch) &&
        ask(kit, m, act, 'ask-pull', 'open a PR', () => createPullPrompt(repo))}
      {(repo.ahead > 0 || repo.upstream === '') &&
        twice(kit, m, act, `push:${repo.root}`, 'push', () => act.sync(repo.root, 'push'))}
    </Box>
  )
}
