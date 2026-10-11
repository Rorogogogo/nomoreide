import type { RenderElement } from 'claude-code'

import type { Diff, GitFile, GitSection, Repo } from '../../types'
import { isChanged, isStaged } from '../git'
import { commitMessagePrompt } from '../prompts'
import { clipEnd, clipStart, plural, splitPath } from '../text'
import { GLYPH } from '../tokens'
import {
  drafts,
  MAX_ROWS,
  NARROW,
  ask,
  chip,
  diffBody,
  fit,
  group,
  heading,
  letter,
  more, moreLines,
  quiet,
  row,
  rowHover,
  rule,
  space,
  strip,
  toneOf,
} from './chrome'
import type { Actions, Kit, Model } from './model'
import { runView, runsList } from './actions'
import { browser, fileView } from './files'
import { commitView, historyList, pullsList } from './history'
import { pullRow, snapshotList, syncRow } from './repo-extras'

const GIT_SECTIONS: readonly { id: GitSection; hotkey: string; label: string }[] = [
  { id: 'changes', hotkey: 'c', label: 'Changes' },
  { id: 'files', hotkey: 'f', label: 'Files' },
  { id: 'history', hotkey: 'h', label: 'History' },
  { id: 'pulls', hotkey: 'r', label: 'PRs' },
  { id: 'actions', hotkey: 'n', label: 'Actions' },
]

export function gitTab(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box } = kit
  if (m.gitSection === 'changes' && m.diff !== null) return diffView(kit, m, m.diff, act)
  if (m.gitSection === 'files' && m.file !== null) return fileView(kit, m, m.file, act)
  if (m.gitSection === 'history' && m.commit !== null) return commitView(kit, m, m.commit, act)
  const openRun = m.run === null ? undefined : m.runs?.items.find(one => one.id === m.run?.id)
  if (m.gitSection === 'actions' && openRun !== undefined && m.runs !== null && m.run !== null) {
    return runView(kit, m, m.runs, openRun, m.run, act)
  }

  return (
    <Box flexDirection="column">
      {strip(kit, m, GIT_SECTIONS, m.gitSection, act.setGitSection)}
      {space(kit)}
      {m.gitSection === 'changes' && changesView(kit, m, act)}
      {m.gitSection === 'files' && browser(kit, m, act)}
      {m.gitSection === 'history' && historyList(kit, m, act)}
      {m.gitSection === 'pulls' && pullsList(kit, m, act)}
      {m.gitSection === 'actions' && runsList(kit, m, act)}
    </Box>
  )
}

function changesView(kit: Kit, m: Model, act: Actions): RenderElement {
  if (m.repos.length === 0) {
    return quiet(
      kit,
      m,
      GLYPH.off,
      'No git repository here',
      'Open Claude Code in a repository, or a folder of them.',
    )
  }
  const only = m.repos.length === 1 ? m.repos[0] : undefined
  const repo = only ?? m.repos.find(one => one.root === m.repo)

  return repo === undefined ? board(kit, m, act) : repoView(kit, m, repo, act)
}

/** What a repository's working tree holds, in a line: `2 staged · 5 modified · 1 untracked`. */
export function treeOf(repo: Repo): string {
  const staged = repo.files.filter(isStaged).length
  const untracked = repo.files.filter(one => one.index === '?').length
  const modified = repo.files.filter(isChanged).length - untracked
  const parts = [
    staged > 0 ? `${staged} staged` : '',
    modified > 0 ? `${modified} modified` : '',
    untracked > 0 ? `${untracked} untracked` : '',
  ]

  return parts.filter(part => part !== '').join(` ${GLYPH.dot} `)
}

export function syncOf(repo: Repo): string {
  if (repo.upstream === '') return 'no upstream'
  if (repo.ahead === 0 && repo.behind === 0) return `level with ${repo.upstream}`
  const ahead = repo.ahead > 0 ? `${repo.ahead} ahead` : ''
  const behind = repo.behind > 0 ? `${repo.behind} behind` : ''

  return `${[ahead, behind].filter(part => part !== '').join(', ')} of ${repo.upstream}`
}

/** Several repositories at once, what has changes first; a name opens one. */
export function board(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const repos = [...m.repos].sort(
    (a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name),
  )

  return (
    <Box flexDirection="column">
      {heading(kit, 'REPOSITORIES', repos.length)}
      {group(kit, m, repos.map(repo => {
        const isDirty = repo.files.length > 0
        const tone = isDirty ? m.colors.busy : m.colors.ok
        const tally = isDirty ? `${repo.files.length} changed` : 'Clean'
        // The branch names the checkout; what it holds and how it stands follow.
        const meta = [repo.branch, treeOf(repo), syncOf(repo)]
          .filter(part => part !== '')
          .join(` ${GLYPH.dot} `)

        return row(
          kit,
          m,
          `row:${repo.name}`,
          { glyph: GLYPH.on, color: tone },
          <Button
            key={`repo:${repo.name}`}
            plain
            label={fit(m, repo.name, tally.length + 4)}
            onPress={() => act.openRepo(repo.root)}
          />,
          <Text color={tone}>{tally}</Text>,
          meta,
        )
      }))}
    </Box>
  )
}

export function fileRow(
  kit: Kit,
  m: Model,
  act: Actions,
  repo: Repo,
  file: GitFile,
  staged: boolean,
): RenderElement {
  const { Box, Text, Button } = kit
  const code = staged ? file.index : file.workingTree
  const { name, dir } = splitPath(file.path)
  const side = staged ? 's' : 'w'
  const shown = fit(m, name, 6)

  return (
    <Box
      key={`row:${side}:${file.path}`}
      flexDirection="row"
      {...rowHover(m)}
    >
      {letter(kit, m, code)}
      <Box flexShrink={0}>
        <Button
          key={`open:${side}:${file.path}`}
          plain
          label={shown}
          onPress={() => act.openDiff(repo.root, file.path, staged)}
        />
      </Box>
      {dir !== '' && (
        <Box flexShrink={1} minWidth={0} marginLeft={2}>
          <Text dimColor wrap="truncate-end">
            {m.isTerminal ? clipStart(dir, Math.max(0, m.width - shown.length - 8)) : dir}
          </Text>
        </Box>
      )}
      <Box flexGrow={1} />
      <Box flexShrink={0} marginLeft={1}>
        <Button
          key={`move:${side}:${file.path}`}
          plain
          dimColor
          label={staged ? GLYPH.remove : GLYPH.add}
          onPress={() => act.move(repo.root, [file.path], !staged)}
        />
      </Box>
    </Box>
  )
}

export function repoView(kit: Kit, m: Model, repo: Repo, act: Actions): RenderElement {
  const { Box, Text, Button, Input } = kit
  const staged = repo.files.filter(isStaged)
  const changed = repo.files.filter(isChanged)
  const isOneOfSeveral = m.repos.length > 1
  const far = isOneOfSeveral ? repo.branch : repo.upstream

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {isOneOfSeveral && (
          <Box flexShrink={0} marginRight={2}>
            <Button key="repos" plain dimColor hotkey="b" label="repos" onPress={() => act.closeRepo()} />
          </Box>
        )}
        <Box flexShrink={1} minWidth={0}>
          <Text bold wrap="truncate-end">
            {fit(m, isOneOfSeveral ? repo.name : repo.branch, isOneOfSeveral ? 28 : 20)}
          </Text>
        </Box>
        {repo.ahead > 0 && <Text color={m.colors.busy}> {GLYPH.ahead}{repo.ahead}</Text>}
        {repo.behind > 0 && <Text color={m.colors.busy}> {GLYPH.behind}{repo.behind}</Text>}
        <Box flexGrow={1} />
        {far !== '' && (
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>{clipEnd(far, m.width < NARROW ? 14 : 28)}</Text>
          </Box>
        )}
      </Box>
      {syncRow(kit, m, repo, act)}
      {pullRow(kit, m, repo, act)}
      {space(kit)}
      {repo.files.length === 0 &&
        quiet(kit, m, '✓', 'Working tree clean', 'Nothing to stage, nothing to commit.')}
      {staged.length > 0 &&
        heading(
          kit,
          'STAGED',
          staged.length,
          <Button
            key="unstage-all"
            {...chip(m)}
            hotkey="u"
            label="unstage all"
            onPress={() => act.moveAll(repo.root, false)}
          />,
        )}
      {staged.length > 0 && group(kit, m, staged.slice(0, MAX_ROWS).map(file => fileRow(kit, m, act, repo, file, true)), 0)}
      {more(kit, staged.length - MAX_ROWS, 'staged')}
      {staged.length > 0 && changed.length > 0 && space(kit)}
      {changed.length > 0 &&
        heading(
          kit,
          'CHANGES',
          changed.length,
          <Button
            key="stage-all"
            {...chip(m)}
            hotkey="a"
            label="stage all"
            onPress={() => act.moveAll(repo.root, true)}
          />,
        )}
      {changed.length > 0 && group(kit, m, changed.slice(0, MAX_ROWS).map(file => fileRow(kit, m, act, repo, file, false)), 0)}
      {more(kit, changed.length - MAX_ROWS, 'changed')}
      {staged.length > 0 && space(kit)}
      {staged.length > 0 && (
        <Box flexDirection="row">
          <Box flexGrow={1} />
          {ask(kit, m, act, 'ask-message', 'write the message', () => commitMessagePrompt(repo))}
        </Box>
      )}
      {staged.length > 0 &&
        (Input === undefined ? (
          <Text dimColor>Commit from a terminal: this surface has no text field.</Text>
        ) : (
          <Input
            key="commit"
            label="commit"
            placeholder={`message for ${plural(staged.length, 'staged file')}`}
            submitLabel="commit"
            onSubmit={message => act.commit(repo.root, message)}
          />
        ))}
      {snapshotList(kit, m, repo, act)}
    </Box>
  )
}

export function diffView(kit: Kit, m: Model, diff: Diff, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const { name, dir } = splitPath(diff.path)
  const repo = m.repos.find(one => one.root === diff.root)
  const file = repo?.files.find(one => one.path === diff.path)
  const code = file === undefined ? ' ' : diff.isStaged ? file.index : file.workingTree
  const side = diff.isStaged ? 'staged' : 'working tree'

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={m.width < NARROW ? 1 : 3}>
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeDiff()} />
        <Box flexGrow={1} />
        <Button
          key="move"
          {...chip(m, false)}
          hotkey="s"
          label={diff.isStaged ? 'unstage' : 'stage'}
          onPress={() => act.move(diff.root, [diff.path], !diff.isStaged)}
        />
        {!diff.path.endsWith('/') && (
          <Button
            key="open-file"
            {...chip(m, false)}
            hotkey="o"
            label="open file"
            onPress={() => act.openFile(`${diff.root}/${diff.path}`)}
          />
        )}
        <Button
          key="mention"
          {...drafts(m)}
          hotkey="p"
          label="to prompt"
          onPress={() => act.mention(diff.root, diff.path)}
        />
      </Box>
      {space(kit)}
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexShrink={0} marginRight={1}>
          <Text bold color={toneOf(code, m.colors)}>
            {code}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          <Box flexDirection="row">
            <Box flexShrink={1} minWidth={0}>
              <Text bold wrap="truncate-end">
                {fit(m, name, side.length + 4)}
              </Text>
            </Box>
            <Box flexGrow={1} />
            <Box flexShrink={0} marginLeft={1}>
              <Text dimColor>{side}</Text>
            </Box>
          </Box>
          {dir !== '' && (
            <Text dimColor wrap="truncate-end">
              {m.isTerminal ? clipStart(dir, m.width - 2) : dir}
            </Text>
          )}
        </Box>
      </Box>
      {rule(kit, m)}
      {diff.hunks === '' ? (
        <Text dimColor>
          {diff.path.endsWith('/')
            ? 'An untracked folder: stage it to see its files.'
            : 'Nothing to show as text: a binary file, or a change of mode alone.'}
        </Text>
      ) : (
        diffBody(kit, m, diff.hunks, diff.path)
      )}
      {moreLines(kit, m, act, diff.hunks, diff.hiddenLines)}
    </Box>
  )
}
