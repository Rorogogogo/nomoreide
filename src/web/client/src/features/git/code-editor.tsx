import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { EditorView, minimalSetup } from "codemirror";

export function CodeEditor({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo(() => editorExtensionsForPath(path, onChangeRef), [path]);

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

export function editorLanguageNameForPath(path: string): string {
  const filename = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = filename.includes(".") ? filename.split(".").pop() ?? "" : "";
  if (ext === "tsx") return "typescriptreact";
  if (ext === "ts") return "typescript";
  if (ext === "jsx") return "javascriptreact";
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "javascript";
  if (ext === "json") return "json";
  if (ext === "css" || ext === "scss" || ext === "less") return "css";
  if (ext === "html" || ext === "xml") return "html";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ext === "yaml" || ext === "yml") return "yaml";
  return "text";
}

function editorExtensionsForPath(
  path: string,
  onChangeRef: MutableRefObject<(value: string) => void>,
): Extension[] {
  const languageName = editorLanguageNameForPath(path);
  return [
    minimalSetup,
    editorTheme,
    syntaxTheme,
    languageExtension(languageName),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    }),
  ];
}

function languageExtension(languageName: string): Extension {
  switch (languageName) {
    case "typescriptreact":
      return javascript({ typescript: true, jsx: true });
    case "typescript":
      return javascript({ typescript: true });
    case "javascriptreact":
      return javascript({ jsx: true });
    case "javascript":
      return javascript();
    case "json":
      return json();
    case "css":
      return css();
    case "html":
      return html();
    case "markdown":
      return markdown();
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

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
    "--cm-operator": "#000000",
    "--cm-meta": "#af00db",
    minHeight: "100%",
    backgroundColor: "#fafafa",
    color: "#000000",
    fontSize: "12px",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: "1.5",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "0.75rem 0",
  },
  ".cm-line": {
    padding: "0 0.75rem",
  },
  ".cm-gutters": {
    backgroundColor: "#f4f4f5",
    borderRight: "1px solid #e4e4e7",
    color: "#a1a1aa",
  },
  ".cm-activeLine": {
    backgroundColor: "#eef2ff",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#e5e7eb",
    color: "#71717a",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#add6ff",
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
    "--cm-operator": "#d4d4d4",
    "--cm-meta": "#c586c0",
    backgroundColor: "#1e1e1e",
    color: "#d4d4d4",
  },
  ".dark & .cm-gutters": {
    backgroundColor: "#252526",
    borderRight: "1px solid #3f3f46",
    color: "#858585",
  },
  ".dark & .cm-activeLine": {
    backgroundColor: "#2a2d2e",
  },
  ".dark & .cm-activeLineGutter": {
    backgroundColor: "#2d2d30",
    color: "#c6c6c6",
  },
  ".dark & .cm-selectionBackground, .dark &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#264f78",
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
