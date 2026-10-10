import type { LyricLine, Track } from '../types'

// Chill mode reads whatever the Mac says is playing, whichever app plays it
// (NetEase Cloud Music, Spotify, Apple Music): the system's own now-playing
// record, asked for through `osascript`, which may read it where another
// program may not. Nothing here plays sound; the player does.

/** Prints the now-playing record as one line of JSON; `{}` when nothing is. */
export const NOW_PLAYING_JS = `ObjC.import('Foundation')
function run() {
  $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/').load
  const Req = $.NSClassFromString('MRNowPlayingRequest')
  const out = {}
  try { out.app = ObjC.unwrap(Req.localNowPlayingPlayerPath.client.bundleIdentifier) } catch (e) {}
  try { out.playing = !!Req.localIsPlaying } catch (e) {}
  const item = Req.localNowPlayingItem
  if (!item || item.isNil()) return JSON.stringify(out)
  const info = item.nowPlayingInfo
  const get = name => {
    const value = info.objectForKey('kMRMediaRemoteNowPlayingInfo' + name)
    return value && !value.isNil() ? value : undefined
  }
  for (const name of ['Title', 'Artist', 'Album']) {
    const value = get(name)
    if (value) out[name.toLowerCase()] = ObjC.unwrap(value)
  }
  for (const name of ['Duration', 'ElapsedTime', 'PlaybackRate']) {
    const value = get(name)
    if (value) out[name.toLowerCase()] = value.doubleValue
  }
  const at = get('Timestamp')
  if (at) out.at = at.timeIntervalSince1970
  return JSON.stringify(out)
}`

/** What the system's media commands are numbered. */
export const MEDIA_COMMAND = { toggle: 2, next: 4, previous: 5 } as const

export type MediaCommand = keyof typeof MEDIA_COMMAND

/** Sends one media command (its number as the argument) to whatever is playing. */
export const MEDIA_COMMAND_JS = `ObjC.import('Foundation')
function run(argv) {
  $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/').load
  ObjC.bindFunction('MRMediaRemoteSendCommand', ['bool', ['int', 'id']])
  return String($.MRMediaRemoteSendCommand(Number(argv[0]), $()))
}`

const PLAYERS: Record<string, string> = {
  'com.netease.163music': 'NetEase',
  'com.spotify.client': 'Spotify',
  'com.apple.Music': 'Apple Music',
}

/** A player's name for a person, from its bundle identifier. */
export function playerName(app: string): string {
  return PLAYERS[app] ?? app.slice(app.lastIndexOf('.') + 1)
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The now-playing record as a track; `null` when nothing with a title is playing. */
export function parseNowPlaying(text: string): Track | null {
  let found: unknown
  try {
    found = JSON.parse(text.trim() || '{}')
  } catch {
    return null
  }
  if (typeof found !== 'object' || found === null) return null
  const row = found as Record<string, unknown>
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  if (title === '') return null
  const rate = num(row.playbackrate)

  return {
    app: typeof row.app === 'string' ? row.app : '',
    title,
    artist: typeof row.artist === 'string' ? row.artist.trim() : '',
    album: typeof row.album === 'string' ? row.album.trim() : '',
    duration: num(row.duration) ?? 0,
    elapsed: num(row.elapsedtime) ?? 0,
    at: Math.round((num(row.at) ?? 0) * 1000),
    isPlaying: row.playing === true && (rate === undefined || rate > 0),
  }
}

/** What tells one song from the next. */
export const trackKey = (track: Track): string => `${track.title}\n${track.artist}`

/** Seconds into the song at `now`: where it was when last reported, and the time since while it plays. */
export function positionOf(track: Track, now: number): number {
  const since = track.isPlaying && track.at > 0 ? Math.max(0, (now - track.at) / 1000) : 0
  const at = track.elapsed + since

  return track.duration > 0 ? Math.min(at, track.duration) : at
}

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

// Credits a lyric file opens with (`作词 : ...`): not sung, so not shown.
const CREDIT = /^[^\s:：]{1,12}\s*[:：]/

/** A timed lyric file (`[mm:ss.xx] words`) as lines in order; one line may carry several times. */
export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(STAMP)]
    if (stamps.length === 0) continue
    const words = raw.replace(STAMP, '').trim()
    if (words === '' || CREDIT.test(words)) continue
    for (const stamp of stamps) {
      const part = stamp[3] ?? '0'
      const at = Number(stamp[1]) * 60 + Number(stamp[2]) + Number(part) / 10 ** part.length
      lines.push({ at, text: words })
    }
  }

  return lines.sort((a, b) => a.at - b.at)
}

/** The line being sung at `seconds`: the last one begun; -1 before the first. */
export function lineAt(lines: readonly LyricLine[], seconds: number): number {
  let found = -1
  for (let at = 0; at < lines.length; at += 1) {
    if ((lines[at]?.at ?? Infinity) > seconds) break
    found = at
  }

  return found
}

const query = (pairs: Record<string, string>): string =>
  Object.entries(pairs)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')

/** LRCLIB's search for a song: a public lyrics library that needs no key. */
export function lrclibUrl(track: Track): string {
  return `https://lrclib.net/api/search?${query({ track_name: track.title, artist_name: track.artist })}`
}

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null) : []

/** How far a found song's length may be from the playing one's and still be it, in seconds. */
const NEAR = 4

/** The timed lyrics of the LRCLIB match nearest the song's length; `''` when none is near. */
export function pickLrclib(reply: unknown, duration: number): string {
  const timed = list(reply)
    .map(one => ({ lyric: typeof one.syncedLyrics === 'string' ? one.syncedLyrics : '', off: Math.abs((num(one.duration) ?? 0) - duration) }))
    .filter(one => one.lyric !== '' && (duration === 0 || one.off <= NEAR))
    .sort((a, b) => a.off - b.off)

  return timed[0]?.lyric ?? ''
}

/** NetEase's own search, for the songs LRCLIB has not. */
export function neteaseSearchUrl(track: Track): string {
  return `https://music.163.com/api/search/get?${query({ s: `${track.title} ${track.artist}`.trim(), type: '1', limit: '8' })}`
}

/** The id of the NetEase match nearest the song's length; `undefined` when none is near. */
export function pickNetease(reply: unknown, track: Track): number | undefined {
  const result = typeof reply === 'object' && reply !== null ? (reply as { result?: { songs?: unknown } }).result : undefined
  const near = list(result?.songs)
    .map(one => ({ id: num(one.id), off: Math.abs((num(one.duration) ?? 0) / 1000 - track.duration) }))
    .filter(one => one.id !== undefined && (track.duration === 0 || one.off <= NEAR))
    .sort((a, b) => a.off - b.off)

  return near[0]?.id
}

export const neteaseLyricUrl = (id: number): string => `https://music.163.com/api/song/lyric?id=${id}&lv=1&tv=-1`

/** The timed lyric text out of NetEase's answer; `''` when it has none. */
export function neteaseLyric(reply: unknown): string {
  const lrc = typeof reply === 'object' && reply !== null ? (reply as { lrc?: { lyric?: unknown } }).lrc : undefined

  return typeof lrc?.lyric === 'string' ? lrc.lyric : ''
}

const NETEASE = 'com.netease.163music'

// NetEase answers neither the system's media commands nor a media key, and
// does not say when it is paused. Its own Controls menu does both: the first
// three items are play or pause, next and previous, in any language.
const NETEASE_MENU = 'menu 1 of menu bar item 4 of menu bar 1'
const NETEASE_ITEM: Record<MediaCommand, number> = { toggle: 1, next: 2, previous: 3 }
const SCRIPTED: Record<string, string> = { 'com.spotify.client': 'Spotify', 'com.apple.Music': 'Music' }
const SCRIPT_VERB: Record<MediaCommand, string> = { toggle: 'playpause', next: 'next track', previous: 'previous track' }

/** The command line that asks `app` to do `command`: its own way where it has one, else the system's. */
export function controlArgv(app: string, command: MediaCommand): string[] {
  if (app === NETEASE) {
    return [
      'osascript',
      '-e',
      `tell application "System Events" to tell process "NeteaseMusic" to click menu item ${NETEASE_ITEM[command]} of ${NETEASE_MENU}`,
    ]
  }
  const name = SCRIPTED[app]
  if (name !== undefined) return ['osascript', '-e', `tell application "${name}" to ${SCRIPT_VERB[command]}`]

  return ['osascript', '-l', 'JavaScript', '-e', MEDIA_COMMAND_JS, String(MEDIA_COMMAND[command])]
}

/** Asks NetEase's menu what its first item offers; `undefined` for a player that reports a pause itself. */
export function pauseProbeArgv(app: string): string[] | undefined {
  return app === NETEASE
    ? ['osascript', '-e', `tell application "System Events" to tell process "NeteaseMusic" to get name of menu item 1 of ${NETEASE_MENU}`]
    : undefined
}

/** A menu that offers "Play" is paused. */
export const offersPlay = (name: string): boolean => /^(play|播放)$/i.test(name.trim())

/** A pause the player did not report: for which play of which song, since when, and how long in all so far. */
export type Held = { key: string; at: number; since: number | null; total: number }

/**
 * A track corrected for pauses its player never reported: the time spent
 * paused is taken out of the time since the song began, and while paused the
 * song stands where it stopped. Returns the track to show and what to carry
 * to the next look.
 */
export function settle(found: Track, isPaused: boolean, held: Held | null, now: number): { track: Track; held: Held } {
  const key = trackKey(found)
  // With no moment to count from there is nothing to correct but the state.
  if (found.at <= 0) return { track: { ...found, isPlaying: !isPaused }, held: { key, at: 0, since: null, total: 0 } }
  const kept = held !== null && held.key === key && held.at === found.at ? held : { key, at: found.at, since: null, total: 0 }
  const next: Held =
    isPaused && kept.since === null
      ? { ...kept, since: now }
      : !isPaused && kept.since !== null
        ? { ...kept, since: null, total: kept.total + (now - kept.since) }
        : kept
  if (next.since !== null) {
    const elapsed = Math.max(0, found.elapsed + (next.since - found.at - next.total) / 1000)

    return { track: { ...found, isPlaying: false, elapsed, at: next.since }, held: next }
  }

  return { track: { ...found, isPlaying: true, at: found.at + next.total }, held: next }
}

/** NetEase's record of one song, which names its album's cover. */
export const neteaseDetailUrl = (id: number): string => `https://music.163.com/api/song/detail?ids=%5B${id}%5D`

/** How many pixels a side the cover is asked for: twice what the opened card draws it at, for a dense screen. */
export const COVER_PX = 480

/** The album cover's address at that size, over https; `''` when the record names none. */
export function neteaseCover(reply: unknown): string {
  const songs = typeof reply === 'object' && reply !== null ? (reply as { songs?: unknown }).songs : undefined
  const album = list(songs)[0]?.album
  const url = typeof album === 'object' && album !== null ? (album as { picUrl?: unknown }).picUrl : undefined
  if (typeof url !== 'string' || !/^https?:\/\/[\w.-]+\.music\.126\.net\//.test(url)) return ''

  return `${url.replace(/^http:/, 'https:')}?param=${COVER_PX}y${COVER_PX}`
}

/** A cover as a drawing a surface without a picture element can show: the JPEG inside, its corners rounded. */
export function coverSvg(jpeg: string): string {
  const side = COVER_PX

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"><defs><clipPath id="r"><rect width="${side}" height="${side}" rx="${side / 8}"/></clipPath></defs><image href="data:image/jpeg;base64,${jpeg}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid slice" clip-path="url(#r)"/></svg>`
}
