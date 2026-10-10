import type { Family } from './files'

// A small highlighter for the diffs the pane draws itself. It reads a line
// at a time and knows six things: a comment, a string, a number, a keyword,
// a type and a call. No grammar: enough to tell a line's parts apart at a
// glance, as a review on GitHub does, and wrong only in the ways a glance forgives.

export type Token = { text: string; kind: 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'type' | 'call' }

const words = (list: string): ReadonlySet<string> => new Set(list.split(' '))

const SCRIPT = words(
  'as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface is keyof let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield declare namespace abstract override',
)

const SYSTEMS = words(
  'as async await break case catch chan class const continue crate default defer do dyn else enum extern false final finally fn for func go goto if impl import in interface let loop match mod move mut namespace new nil null package private protected pub public ref return self Self static struct super switch this throw throws trait true try type typedef union unsafe use using var void where while override internal guard extension protocol select range map',
)

const PYTHON = words(
  'and as assert async await begin break case class continue def defmodule defp del do elif else elsif end ensure except false False finally for from function global if import in is lambda local module nil None nonlocal not or pass raise require rescue return self then true True try unless until when while with yield echo foreach',
)

const SHELL = words(
  'case do done echo elif else esac exit export fi for function if in local return set then unset until while',
)

const DATA = words('true false null yes no on off')

type Rules = { keywords: ReadonlySet<string>; line: readonly string[]; hasBlock: boolean; quotes: string }

const RULES: Readonly<Record<Family, Rules | undefined>> = {
  typed: { keywords: SCRIPT, line: ['//'], hasBlock: true, quotes: '"\'`' },
  script: { keywords: SCRIPT, line: ['//'], hasBlock: true, quotes: '"\'`' },
  systems: { keywords: SYSTEMS, line: ['//'], hasBlock: true, quotes: '"\'' },
  python: { keywords: PYTHON, line: ['#', '--'], hasBlock: false, quotes: '"\'' },
  shell: { keywords: SHELL, line: ['#'], hasBlock: false, quotes: '"\'' },
  data: { keywords: DATA, line: ['#', '//', '--'], hasBlock: false, quotes: '"\'' },
  style: { keywords: new Set(), line: [], hasBlock: true, quotes: '"\'' },
  prose: undefined,
  image: undefined,
  other: undefined,
}

/** Whether a family's files are coloured at all: prose, pictures and the unknown are not. */
export const isHighlighted = (family: Family): boolean => RULES[family] !== undefined

/**
 * One line as its coloured parts. `inBlock` says a block comment is open
 * from a line before; what comes back says whether one is open after.
 */
export function highlight(line: string, family: Family, inBlock = false): { tokens: Token[]; inBlock: boolean } {
  const rules = RULES[family]
  if (rules === undefined) return { tokens: [{ text: line, kind: 'plain' }], inBlock: false }
  const tokens: Token[] = []
  const push = (text: string, kind: Token['kind']): void => {
    if (text === '') return
    const last = tokens.at(-1)
    if (last !== undefined && last.kind === kind) last.text += text
    else tokens.push({ text, kind })
  }
  let at = 0
  let open = inBlock
  while (at < line.length) {
    const rest = line.slice(at)
    if (open) {
      const end = rest.indexOf('*/')
      const taken = end < 0 ? rest : rest.slice(0, end + 2)
      push(taken, 'comment')
      at += taken.length
      open = end < 0
      continue
    }
    if (rules.hasBlock && rest.startsWith('/*')) {
      open = true
      push('/*', 'comment')
      at += 2
      continue
    }
    if (rules.line.some(mark => rest.startsWith(mark) && (mark !== '--' || /^--(\s|$)/.test(rest)))) {
      push(rest, 'comment')
      break
    }
    const char = rest[0] ?? ''
    if (rules.quotes.includes(char)) {
      // To the same quote again, a backslash keeping the next character; unclosed, to the line's end.
      let end = 1
      while (end < rest.length && rest[end] !== char) end += rest[end] === '\\' ? 2 : 1
      const taken = rest.slice(0, Math.min(rest.length, end + 1))
      push(taken, 'string')
      at += taken.length
      continue
    }
    const number = /^(0[xXbBoO][\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)[a-zA-Z%]*/.exec(rest)
    if (number !== null && !/[\w$]/.test(line[at - 1] ?? '')) {
      push(number[0], 'number')
      at += number[0].length
      continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (word !== null) {
      const text = word[0]
      const after = rest.slice(text.length)
      const kind: Token['kind'] = rules.keywords.has(text)
        ? 'keyword'
        : /^[A-Z][A-Za-z0-9]*[a-z]/.test(text)
          ? 'type'
          : /^\s*\(/.test(after)
            ? 'call'
            : 'plain'
      push(text, kind)
      at += text.length
      continue
    }
    push(char, 'plain')
    at += 1
  }

  return { tokens, inBlock: open }
}

/** The part of a line's tokens between two character places: what one row of a wrapped line holds. */
export function sliceTokens(tokens: readonly Token[], from: number, to: number): Token[] {
  const out: Token[] = []
  let at = 0
  for (const token of tokens) {
    const start = Math.max(from, at)
    const end = Math.min(to, at + token.text.length)
    if (start < end) out.push({ text: token.text.slice(start - at, end - at), kind: token.kind })
    at += token.text.length
  }

  return out
}
