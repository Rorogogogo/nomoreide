import type { Color, RenderElement } from 'claude-code'

import type { Commit, OpenCommit, PullItem, Repo } from '../../types'
import { layoutMessage } from '../git'
import { graphSvg, graphWidth } from '../icons'
import { reviewPullPrompt } from '../prompts'
import { age, splitPath } from '../text'
import { GLYPH } from '../tokens'
import { MAX_ROWS, NARROW, ask, diffBody, fit, group, heading, letter, moreLines, quiet, row, rule, space } from './chrome'
import type { Actions, Kit, Model } from './model'

/** The repository the Git tab is looking at: the only one, or the one opened under Changes. */
function inView(m: Model): Repo | undefined {
  return m.repos.length === 1 ? m.repos[0] : m.repos.find(one => one.root === m.repo)
}

function noRepo(kit: Kit, m: Model, what: string): RenderElement {
  return m.repos.length === 0
    ? quiet(kit, m, GLYPH.off, 'No git repository here', `${what} belong to a repository.`)
    : quiet(kit, m, GLYPH.off, 'No repository in view', `Open one under Changes; its ${what.toLowerCase()} are listed here.`)
}

/** How long ago, from epoch milliseconds. */
const since = (m: Model, at: number): string => (at > 0 ? age(m.now, new Date(at).toISOString()) : '')

/** The graph's characters for one line: drawn where a surface draws pictures, typed on a cell grid. */
function lane(kit: Kit, m: Model, graph: string, isFirst: boolean): RenderElement {
  const { Box, Text, Svg } = kit
  if (Svg === undefined) {
    return (
      <Box flexShrink={0}>
        <Text color={m.colors.accent}>{graph} </Text>
      </Box>
    )
  }

  return (
    <Box flexShrink={0} marginRight={1}>
      <Svg source={graphSvg(graph, isFirst)} alt={graph.includes('*') ? 'commit' : 'branch line'} width={graphWidth(graph)} height={19} />
    </Box>
  )
}

/** The branches and tags shown at a commit, each cut to what a row spares. */
const shownRefs = (m: Model, commit: Commit): string[] =>
  commit.refs.slice(0, m.width < NARROW ? 1 : 3).map(ref => fit(m, ref, m.width < NARROW ? 20 : 40))

/** The branches and tags at a commit, each a quiet word in the accent. */
function refsOf(kit: Kit, m: Model, refs: string[]): RenderElement | false {
  return (
    refs.length > 0 && (
      <kit.Box flexShrink={0} flexDirection="row" columnGap={1} marginRight={1}>
        {refs.map(ref => (
          <kit.Text key={`ref:${ref}`} color={m.colors.accent}>
            {ref}
          </kit.Text>
        ))}
      </kit.Box>
    )
  )
}

/** The commit graph of every branch, the newest first; a subject opens its commit. */
export function historyList(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const repo = inView(m)
  if (repo === undefined) return noRepo(kit, m, 'Commits')
  const history = m.history !== null && m.history.root === repo.root ? m.history : null
  if (history === null) return quiet(kit, m, GLYPH.off, 'Reading the history', 'One moment.')
  const commits = history.rows.filter(one => one.sha !== '')
  if (commits.length === 0) return quiet(kit, m, GLYPH.off, 'No commits yet', 'The first commit starts the graph.')
  const first = history.rows.findIndex(one => one.sha !== '')

  return (
    <Box flexDirection="column">
      {heading(kit, 'HISTORY', commits.length)}
      {group(
        kit,
        m,
        history.rows.slice(0, MAX_ROWS).map((commit, at) => {
          const refs = commit.sha === '' ? [] : shownRefs(m, commit)
          // A subject is one line: what the graph, the names and the age leave it, then an ellipsis.
          const taken = commit.graph.length + refs.reduce((sum, ref) => sum + ref.length + 1, 0) + 7

          return (
            <Box key={`row:log:${at}`} flexDirection="row" alignItems="center">
              {lane(kit, m, commit.graph, at === first)}
              {refsOf(kit, m, refs)}
              {commit.sha !== '' && (
                <Box flexShrink={1} minWidth={0}>
                  <Button
                    key={`commit:${commit.sha}`}
                    plain
                    label={fit(m, commit.subject, taken)}
                    onPress={() => act.openCommit(repo.root, commit.sha)}
                  />
                </Box>
              )}
              <Box flexGrow={1} />
              {commit.sha !== '' && (
                <Box flexShrink={0} marginLeft={1}>
                  <Text dimColor>{since(m, commit.at)}</Text>
                </Box>
              )}
            </Box>
          )
        }),
        0,
      )}
    </Box>
  )
}

/** `Claude-Session` as words: a trailer's key is written to be parsed, not read. */
const worded = (key: string): string => key.replace(/-/g, ' ').replace(/^(.)(.*)$/, (_, head: string, rest: string) => head + rest.toLowerCase())

/**
 * What a commit says under its subject: prose for the pane to wrap, list
 * items hanging under their marks, and the trailers apart at the foot, an
 * address among them a press that opens it.
 */
function message(kit: Kit, m: Model, body: string, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const { paragraphs, trailers } = layoutMessage(body)

  return (
    <Box flexDirection="column" marginTop={1} rowGap={1}>
      {paragraphs.map((lines, at) => (
        <Box key={`msg:${at}`} flexDirection="column">
          {lines.map((line, row) =>
            line.mark === '' ? (
              <Text key={`msg:${at}:${row}`} dimColor>
                {line.text}
              </Text>
            ) : (
              <Box key={`msg:${at}:${row}`} flexDirection="row">
                <Box flexShrink={0} width={m.isTerminal ? line.mark.length + 1 : 1.5}>
                  <Text dimColor>{line.mark === '-' || line.mark === '*' || line.mark === '+' ? GLYPH.dot : line.mark}</Text>
                </Box>
                <Box flexShrink={1} minWidth={0}>
                  <Text dimColor>{line.text}</Text>
                </Box>
              </Box>
            ),
          )}
        </Box>
      ))}
      {trailers.length > 0 && (
        <Box flexDirection="column">
          {trailers.map(one => {
            const isAddress = /^https?:\/\/\S+$/.test(one.value)

            return (
              <Box key={`trailer:${one.key}:${one.value}`} flexDirection="row" alignItems="center">
                <Box flexShrink={0} marginRight={m.isTerminal ? 2 : 1}>
                  <Text dimColor>{worded(one.key)}</Text>
                </Box>
                <Box flexShrink={1} minWidth={0}>
                  {isAddress ? (
                    <Button
                      key={`open:${one.value}`}
                      plain
                      label={fit(m, one.value.replace(/^https?:\/\//, ''), one.key.length + 4)}
                      onPress={() => act.openUrl(one.value)}
                    />
                  ) : (
                    <Text dimColor wrap="truncate-end">
                      {one.value}
                    </Text>
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

/** One commit: who made it and when, what it says, the files it touched, and the diff of the one picked. */
export function commitView(kit: Kit, m: Model, commit: OpenCommit, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const where = commit.root.slice(commit.root.lastIndexOf('/') + 1)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={m.width < NARROW ? 1 : 2}>
        <Button
          key="back"
          plain
          dimColor
          hotkey="b"
          label="back"
          onPress={() => (commit.diff === null ? act.closeCommit() : act.openCommitFile(''))}
        />
        <Box flexGrow={1} />
        {ask(
          kit,
          m,
          act,
          'ask-commit',
          'explain',
          () => `Explain commit ${commit.sha} ("${commit.subject}") in the ${where} repository: what it changed and why. Read it with \`git show ${commit.sha}\`.`,
        )}
      </Box>
      {space(kit)}
      <Text bold>{commit.subject}</Text>
      <Text dimColor wrap="truncate-end">
        {[commit.sha, commit.author, `${since(m, commit.at)} ago`].filter(part => part !== '').join(` ${GLYPH.dot} `)}
      </Text>
      {commit.body !== '' && commit.diff === null && message(kit, m, commit.body, act)}
      {rule(kit, m)}
      {commit.diff === null ? (
        <Box flexDirection="column">
          {heading(kit, 'FILES', commit.files.length)}
          {commit.files.length === 0 ? (
            <Text dimColor>This commit touched no files: a merge, or an empty one.</Text>
          ) : (
            group(
              kit,
              m,
              commit.files.slice(0, MAX_ROWS).map(file => {
                const { name, dir } = splitPath(file.path)

                return (
                  <Box key={`row:cf:${file.path}`} flexDirection="row" alignItems="center">
                    {letter(kit, m, file.status)}
                    <Box flexShrink={0}>
                      <Button key={`cfile:${file.path}`} plain label={fit(m, name, 8)} onPress={() => act.openCommitFile(file.path)} />
                    </Box>
                    {dir !== '' && (
                      <Box flexShrink={1} minWidth={0} marginLeft={2}>
                        <Text dimColor wrap="truncate-end">
                          {dir}
                        </Text>
                      </Box>
                    )}
                  </Box>
                )
              }),
              0,
            )
          )}
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            {commit.diff.path}
          </Text>
          {space(kit)}
          {commit.diff.hunks === '' ? (
            <Text dimColor>Nothing to show as text: a binary file, or a change of mode alone.</Text>
          ) : (
            diffBody(kit, m, commit.diff.hunks, commit.diff.path)
          )}
          {moreLines(kit, m, act, commit.diff.hunks, commit.diff.hiddenLines)}
        </Box>
      )}
    </Box>
  )
}

function checksOf(pull: PullItem, m: Model): { glyph: string; color: Color } {
  if (pull.checks === 'failing') return { glyph: GLYPH.on, color: m.colors.bad }
  if (pull.checks === 'running') return { glyph: GLYPH.on, color: m.colors.busy }
  if (pull.checks === 'passing') return { glyph: GLYPH.on, color: m.colors.ok }

  return { glyph: GLYPH.off, color: m.colors.inert }
}

/** The repository's open pull requests; a title opens it on GitHub, and a review is asked of Claude. */
export function pullsList(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const repo = inView(m)
  if (repo === undefined) return noRepo(kit, m, 'Pull requests')
  const pulls = m.pullList !== null && m.pullList.root === repo.root ? m.pullList : null
  if (pulls === null) return quiet(kit, m, GLYPH.off, 'Asking GitHub', 'One moment.')
  if (pulls.note !== '') return quiet(kit, m, GLYPH.off, 'No pull requests to show', pulls.note)
  if (pulls.items.length === 0) return quiet(kit, m, GLYPH.off, 'No open pull requests', 'Open ones are listed here.')

  return (
    <Box flexDirection="column">
      {heading(kit, 'OPEN PULL REQUESTS', pulls.items.length)}
      {group(
        kit,
        m,
        pulls.items.slice(0, MAX_ROWS).map(pull => {
          const mark = checksOf(pull, m)
          const checks = pull.checks === 'none' ? '' : `${pull.passed}/${pull.total} checks`

          return row(
            kit,
            m,
            `row:pr:${pull.number}`,
            mark,
            <Button
              key={`pr:${pull.number}`}
              plain
              label={fit(m, `#${pull.number} ${pull.title}`, 14)}
              onPress={() => act.openUrl(pull.url)}
            />,
            m.width >= NARROW && ask(kit, m, act, `pr-review:${pull.number}`, 'review', () => reviewPullPrompt(pull)),
            [pull.isDraft ? 'draft' : '', pull.branch, pull.author, checks, pull.updatedAt === '' ? '' : `${age(m.now, pull.updatedAt)} ago`]
              .filter(part => part !== '')
              .join(` ${GLYPH.dot} `),
          )
        }),
      )}
      {space(kit)}
      <Text dimColor>A title opens the pull request on GitHub.</Text>
    </Box>
  )
}
