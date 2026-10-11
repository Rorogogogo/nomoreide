import type { RenderElement } from 'claude-code'

import { coverSvg, playerName } from '../music'
import { LYRIC, lyricSvg } from '../icons'
import { GLYPH } from '../tokens'
import { group, heading } from './chrome'
import type { Actions, Kit, Model } from './model'

/** The song's name and who sings it, as one quiet line. */
const credit = (m: Model): string =>
  m.track === null ? '' : m.track.artist === '' ? m.track.title : `${m.track.title} ${GLYPH.dot} ${m.track.artist}`

/** The line being sung; `''` before the first, between songs, or with no lyrics. */
const sung = (m: Model): string => m.lyrics?.lines[m.lyricAt]?.text ?? ''

/** The cover's side as drawn, in pixels: the closed card's three lines, and three times that with the card opened up, beside the lyric. */
const COVER_SHOWN = { small: 56, wide: 168 }

/** A line of type's height in pixels, off a cell grid. */
const LINE_PX = 19

/** The least width, in cells, at which the song sits beside its lyric, and the cells the song is given there. */
const SIDE_BY_SIDE = 56
const SONG_COLUMN = 30

/** How many lines the card shows either side of the one being sung: closed, then opened up. */
const LINES = { small: { before: 1, after: 1 }, wide: { before: 5, after: 5 } }

/** The way into chill mode and out of it, in the header. */
export function chillToggle(kit: Kit, m: Model, act: Actions): RenderElement {
  return (
    <kit.Button
      key="chill"
      plain
      {...(m.isChill ? {} : { dimColor: true })}
      label={m.isChill ? `${GLYPH.note} chill on` : `${GLYPH.note} chill`}
      onPress={() => act.toggleChill()}
    />
  )
}

/**
 * Chill mode's card, above whatever view is in front: what is playing and in which app,
 * the ways to pause it and move on, and the lyric with a line either side.
 */
export function nowPlaying(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button, Svg } = kit
  const song = m.track
  if (song === null) {
    return (
      <Box flexDirection="column">
        {heading(kit, 'NOW PLAYING')}
        {group(kit, m, [
          <Text key="idle" dimColor wrap="truncate-end">
            Nothing playing. Start a song in NetEase, Spotify or Apple Music.
          </Text>,
        ])}
      </Box>
    )
  }
  const lines = m.lyrics?.lines ?? []
  const size = m.isChillWide ? 'wide' : 'small'
  const before = lines.slice(Math.max(0, m.lyricAt - LINES[size].before), Math.max(0, m.lyricAt))
  const after = lines.slice(m.lyricAt + 1, m.lyricAt + 1 + LINES[size].after)
  const now = sung(m)

  // Opened up with the room, the cover stands as tall as the lyric beside it,
  // short of crowding the lyric out of a narrower pane.
  const beside = m.isChillWide && m.width >= SIDE_BY_SIDE
  // Where a surface draws pictures the opened lyric is one, in a larger face with air between its lines.
  const isDrawn = beside && Svg !== undefined
  const inner = (m.width - 4) * 8
  // The drawn lyric and the cover are fitted to each other: as many lines as
  // the cover is tall at this width, and the cover exactly those lines tall.
  // An odd count, so one row is the middle one.
  const fitRows = Math.min(LINES.wide.before + 1 + LINES.wide.after, Math.floor((inner * 0.45) / LYRIC.line))
  const drawnRows = Math.max(5, fitRows % 2 === 0 ? fitRows - 1 : fitRows)
  const side = isDrawn
    ? drawnRows * LYRIC.line
    : beside
      ? Math.round(Math.min((LINES.wide.before + 1 + LINES.wide.after) * LINE_PX, inner * 0.45))
      : COVER_SHOWN[size]
  const cover = Svg !== undefined && m.cover !== null && (
    <Box flexShrink={0}>
      <Svg
        source={coverSvg(m.cover.jpeg)}
        alt={`Album cover: ${song.album || song.title}`}
        width={side}
        height={side}
      />
    </Box>
  )
  const names = (
    <Box flexShrink={1} minWidth={0} flexDirection="column">
      <Text bold wrap="truncate-end">
        {song.title}
      </Text>
      <Text dimColor wrap="truncate-end">
        {[song.artist, playerName(song.app)].filter(part => part !== '').join(` ${GLYPH.dot} `)}
      </Text>
    </Box>
  )
  const mark = m.isTerminal ? GLYPH.cells : GLYPH
  const controls = (
    <Box flexShrink={0} flexDirection="row" columnGap={m.isTerminal ? 2 : 0.5}>
      <Button key="media-previous" plain dimColor label={mark.previous} onPress={() => act.media('previous')} />
      <Button key="media-toggle" plain label={song.isPlaying ? mark.pause : mark.play} onPress={() => act.media('toggle')} />
      <Button key="media-next" plain dimColor label={mark.next} onPress={() => act.media('next')} />
      <Button
        key="chill-wide"
        plain
        dimColor
        label={m.isChillWide ? mark.collapse : mark.expand}
        onPress={() => act.toggleChillWide()}
      />
    </Box>
  )
  const lyric = (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
      {m.lyrics === null && <Text dimColor>Looking for lyrics</Text>}
      {m.lyrics !== null && lines.length === 0 && <Text dimColor>No timed lyrics found for this song.</Text>}
      {before.map((line, at) => (
        <Text key={`before-${at}`} dimColor wrap="truncate-end">
          {line.text}
        </Text>
      ))}
      {lines.length > 0 && now !== '' && (
        <Box flexDirection="row">
          <Text color={m.colors.accent}>{GLYPH.note} </Text>
          <Box flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">
              {now}
            </Text>
          </Box>
        </Box>
      )}
      {after.map((line, at) => (
        <Text key={`after-${at}`} dimColor wrap="truncate-end">
          {line.text}
        </Text>
      ))}
    </Box>
  )
  // The line being sung keeps the middle row and the rest move past it: a
  // line short at the song's start or end leaves its row empty.
  const nowRow = (drawnRows - 1) / 2
  const shownLines = Array.from({ length: drawnRows }, (_, row) => lines[m.lyricAt + row - nowRow]?.text ?? '')
  const lyricRoom = Math.max(120, inner - (m.cover === null ? 0 : side + 16))
  const lyricDrawn =
    isDrawn && Svg !== undefined && lines.length > 0 ? (
      <Box flexShrink={0}>
        <Svg
          source={lyricSvg(m.scheme, shownLines, now === '' ? -1 : nowRow, lyricRoom)}
          alt={now === '' ? 'The lyric' : `The lyric, at: ${now}`}
          width={lyricRoom}
        />
      </Box>
    ) : undefined
  // Closed, with the room: the lyric at the left and the song beside it, three
  // lines in all. Opened up, or in a sidebar: the song above its lyric.
  const isBeside = !m.isChillWide && m.width >= SIDE_BY_SIDE
  const isOpenWide = m.isChillWide && m.width >= SIDE_BY_SIDE

  return (
    <Box flexDirection="column">
      {heading(kit, 'NOW PLAYING')}
      {group(
        kit,
        m,
        isBeside
          ? [
              <Box key="song" flexDirection="row" alignItems="flex-start">
                {lyric}
                <Box
                  flexShrink={0}
                  width={SONG_COLUMN}
                  marginLeft={2}
                  flexDirection="row"
                  alignItems="center"
                  justifyContent="flex-end"
                  columnGap={1.5}
                >
                  {/* The name and the marks under it start at one edge: a press has half a cell of room before its mark. */}
                  <Box flexShrink={1} minWidth={0} flexDirection="column" alignItems="flex-start">
                    <Box flexShrink={1} minWidth={0} paddingLeft={m.isTerminal ? 0 : 0.5}>
                      {names}
                    </Box>
                    {controls}
                  </Box>
                  {cover}
                </Box>
              </Box>,
            ]
          : isOpenWide
            ? [
                // Opened up, with the room: the song and its marks across the top,
                // the lyric down the left, and the cover in the space beside it.
                <Box key="song" flexDirection="row" alignItems="center" columnGap={1.5}>
                  {names}
                  <Box flexGrow={1} />
                  {controls}
                </Box>,
                <Box key="lyric" flexDirection="row" alignItems="flex-start" marginTop={1} columnGap={2}>
                  {lyricDrawn ?? lyric}
                  {lyricDrawn !== undefined && <Box flexGrow={1} />}
                  {cover}
                </Box>,
              ]
            : [
                <Box key="song" flexDirection="row" alignItems="center" columnGap={1.5}>
                  {cover}
                  {names}
                  <Box flexGrow={1} />
                  {controls}
                </Box>,
                <Box key="lyric" flexDirection="row" marginTop={1}>
                  {lyric}
                </Box>,
              ],
        0,
      )}
    </Box>
  )
}

/** The band's second row in chill mode: the line being sung, and the song at the far end. */
export function lyricRow(kit: Kit, m: Model): RenderElement | undefined {
  const { Box, Text } = kit
  if (!m.isChill || m.track === null) return undefined
  const now = sung(m)

  return (
    <Box flexDirection="row">
      <Text color={m.colors.accent}>{GLYPH.note} </Text>
      <Box flexShrink={1} minWidth={0}>
        <Text {...(now === '' ? { dimColor: true } : {})} wrap="truncate-end">
          {now === '' ? credit(m) : now}
        </Text>
      </Box>
      <Box flexGrow={1} />
      {now !== '' && (
        <Box flexShrink={2} minWidth={0} marginLeft={2}>
          <Text dimColor wrap="truncate-end">
            {credit(m)}
          </Text>
        </Box>
      )}
    </Box>
  )
}
