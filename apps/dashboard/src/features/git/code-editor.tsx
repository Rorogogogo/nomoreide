import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { EditorState, type Extension } from "@codemirror/state";
import {
  HighlightStyle,
  StreamLanguage,
  type StreamParser,
  syntaxHighlighting,
} from "@codemirror/language";
import { c, cpp, csharp, java, kotlin, objectiveC, scala } from "@codemirror/legacy-modes/mode/clike";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { python } from "@codemirror/legacy-modes/mode/python";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { highlightActiveLine, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { EditorView, minimalSetup } from "codemirror";

export function CodeEditor({
  ariaLabel,
  path,
  readOnly = false,
  value,
  onChange,
}: {
  ariaLabel?: string;
  path: string;
  readOnly?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo(
    () => editorExtensionsForPath(path, onChangeRef, readOnly, ariaLabel),
    [ariaLabel, path, readOnly],
  );

  useEffect(() => {
    if (!hostRef.current) return;

    const view = new EditorView({
      doc: value,
      extensions,
      parent: hostRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return <div className="nomoreide-code-editor" ref={hostRef} />;
}

/** A CodeMirror 5 grammar, adapted to run as a CodeMirror 6 language. */
const stream = (parser: StreamParser<unknown>) => () => StreamLanguage.define(parser);

/**
 * Extension → grammar, keyed the same way the read view's `languageFor` is.
 *
 * The read view highlights with highlight.js, which knows far more languages
 * than CodeMirror ships native grammars for. With only the six `@codemirror/
 * lang-*` packages, anything else — C#, Python, Go, Rust, Java, shell — fell
 * through to no parser at all, so opening a `.cs` file for editing dropped
 * every colour and looked like a different file. `@codemirror/legacy-modes`
 * covers the remainder, so the two views agree on what they can highlight.
 */
const GRAMMARS: Record<string, [name: string, load: () => Extension]> = {
  ts: ["typescript", () => javascript({ typescript: true })],
  tsx: ["typescriptreact", () => javascript({ typescript: true, jsx: true })],
  jsx: ["javascriptreact", () => javascript({ jsx: true })],
  js: ["javascript", () => javascript()],
  mjs: ["javascript", () => javascript()],
  cjs: ["javascript", () => javascript()],
  json: ["json", () => json()],
  css: ["css", () => css()],
  scss: ["css", () => css()],
  less: ["css", () => css()],
  html: ["html", () => html()],
  xml: ["html", () => html()],
  md: ["markdown", () => markdown()],
  mdx: ["markdown", () => markdown()],
  markdown: ["markdown", () => markdown()],
  yaml: ["yaml", () => yaml()],
  yml: ["yaml", () => yaml()],
  cs: ["csharp", stream(csharp)],
  java: ["java", stream(java)],
  kt: ["kotlin", stream(kotlin)],
  kts: ["kotlin", stream(kotlin)],
  scala: ["scala", stream(scala)],
  c: ["c", stream(c)],
  h: ["c", stream(c)],
  cpp: ["cpp", stream(cpp)],
  cc: ["cpp", stream(cpp)],
  hpp: ["cpp", stream(cpp)],
  m: ["objectivec", stream(objectiveC)],
  py: ["python", stream(python)],
  go: ["go", stream(go)],
  rs: ["rust", stream(rust)],
  rb: ["ruby", stream(ruby)],
  swift: ["swift", stream(swift)],
  sh: ["bash", stream(shell)],
  bash: ["bash", stream(shell)],
  zsh: ["bash", stream(shell)],
  sql: ["sql", stream(standardSQL)],
  toml: ["toml", stream(toml)],
  ini: ["ini", stream(properties)],
  cfg: ["ini", stream(properties)],
  conf: ["ini", stream(properties)],
  env: ["ini", stream(properties)],
};

const DOCKERFILE: [string, () => Extension] = [
  "dockerfile",
  () => StreamLanguage.define(dockerFile),
];

function grammarForPath(path: string): [string, () => Extension] | undefined {
  const filename = path.split("/").pop()?.toLowerCase() ?? "";
  if (filename === "dockerfile" || filename.startsWith("dockerfile.")) return DOCKERFILE;
  const ext = filename.includes(".") ? filename.split(".").pop() ?? "" : "";
  return GRAMMARS[ext];
}

export function editorLanguageNameForPath(path: string): string {
  return grammarForPath(path)?.[0] ?? "text";
}

function languageExtensionForPath(path: string): Extension {
  return grammarForPath(path)?.[1]() ?? [];
}

function editorExtensionsForPath(
  path: string,
  onChangeRef: MutableRefObject<(value: string) => void>,
  readOnly: boolean,
  ariaLabel?: string,
): Extension[] {
  return [
    minimalSetup,
    /*
     * `minimalSetup` ships none of these. Without them, switching from the
     * read view to edit dropped the line-number gutter the reader had, which
     * read as the whole file changing rather than as the same file becoming
     * editable. The active-line highlight doubles as a second cue for where
     * the caret is.
     */
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    editorTheme,
    syntaxTheme,
    languageExtensionForPath(path),
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    ...(ariaLabel ? [EditorView.contentAttributes.of({ "aria-label": ariaLabel })] : []),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    }),
  ];
}

/**
 * Editor chrome comes from the app's own tokens, only the syntax palette is
 * the editor's own.
 *
 * The surface used to be hardcoded VSCode greys (`#1e1e1e` / `#fafafa`), which
 * are not this app's background — entering edit mode visibly swapped the panel
 * to a different, cooler dark. Driving background, gutters, selection and rules
 * off `hsl(var(--…))` keeps the editor on the same surface as everything around
 * it, and follows the theme toggle for free, so only the token values below
 * need a light/dark split.
 */
const editorTheme = EditorView.theme({
  "&": {
    "--cm-keyword": "#0000ff",
    "--cm-builtin": "#0070c1",
    "--cm-type": "#267f99",
    "--cm-function": "#795e26",
    "--cm-string": "#a31515",
    "--cm-number": "#098658",
    "--cm-comment": "#008000",
    "--cm-variable": "#001080",
    "--cm-tag": "#800000",
    "--cm-attribute": "#ff0000",
    "--cm-operator": "hsl(var(--foreground))",
    "--cm-meta": "#af00db",
    minHeight: "100%",
    backgroundColor: "hsl(var(--background))",
    color: "hsl(var(--foreground))",
    fontSize: "12px",
  },
  ".cm-scroller": {
    fontFamily:
      '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: "1.5",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "0.75rem 0",
    caretColor: "hsl(var(--accent))",
  },
  ".cm-line": {
    padding: "0 0.75rem",
  },
  /*
   * `drawSelection` (via minimalSetup) swaps the native caret for an element it
   * paints itself, and `EditorView.theme` registers as a light theme unless
   * told otherwise — so CodeMirror's base styles drew a black caret, invisible
   * against a dark background. Both the block caret and the drop cursor are set
   * explicitly here, and to the accent so it reads at a glance.
   */
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid hsl(var(--accent))",
  },
  "&.cm-focused .cm-cursor": {
    borderLeft: "2px solid hsl(var(--accent))",
  },
  // No `borderRight`: the gutter shares the editor's background and is set
  // apart by contrast alone, like the file and diff viewers.
  ".cm-gutters": {
    backgroundColor: "hsl(var(--background))",
    border: "none",
    color: "hsl(var(--muted-foreground) / 0.6)",
    paddingRight: "0.5rem",
  },
  ".cm-activeLine": {
    backgroundColor: "hsl(var(--muted) / 0.45)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "hsl(var(--muted))",
    color: "hsl(var(--foreground))",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "hsl(var(--accent) / 0.3)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".dark &": {
    "--cm-keyword": "#569cd6",
    "--cm-builtin": "#4ec9b0",
    "--cm-type": "#4ec9b0",
    "--cm-function": "#dcdcaa",
    "--cm-string": "#ce9178",
    "--cm-number": "#b5cea8",
    "--cm-comment": "#6a9955",
    "--cm-variable": "#9cdcfe",
    "--cm-tag": "#569cd6",
    "--cm-attribute": "#9cdcfe",
    "--cm-operator": "hsl(var(--foreground))",
    "--cm-meta": "#c586c0",
  },
});

const syntaxTheme = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.atom, t.bool], color: "var(--cm-keyword)" },
    {
      tag: [t.standard(t.variableName), t.self, t.special(t.variableName)],
      color: "var(--cm-builtin)",
    },
    { tag: [t.typeName, t.className], color: "var(--cm-type)" },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName)],
      color: "var(--cm-function)",
    },
    { tag: [t.string, t.special(t.string), t.character], color: "var(--cm-string)" },
    { tag: [t.number, t.regexp], color: "var(--cm-number)" },
    { tag: t.comment, color: "var(--cm-comment)", fontStyle: "italic" },
    {
      tag: [t.variableName, t.definition(t.variableName)],
      color: "var(--cm-variable)",
    },
    { tag: [t.tagName, t.angleBracket], color: "var(--cm-tag)" },
    { tag: t.attributeName, color: "var(--cm-attribute)" },
    { tag: [t.operator, t.punctuation, t.bracket], color: "var(--cm-operator)" },
    { tag: t.meta, color: "var(--cm-meta)" },
  ]),
);
