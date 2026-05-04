/**
 * Thin React wrapper around CodeMirror 6.
 *
 * Lifecycle is split deliberately into two effects:
 * - **Init effect** (mount-once) builds the EditorView with extensions
 *   captured at mount. Extensions cannot be hot-swapped here without a
 *   reconfigure (`StateEffect.reconfigure`); for our use the extension
 *   list is stable per-editor-instance, so this is fine.
 * - **Sync effect** observes `value` changes coming from outside (e.g.
 *   navigation switches the focused node) and dispatches a doc-replace
 *   transaction *only when* the incoming value differs from the editor's
 *   current doc, to avoid clobbering the user's cursor mid-typing.
 *
 * `onChange` is captured via a ref so the updateListener doesn't cling
 * to a stale closure across renders. Same trick for `extensions` so the
 * caller can safely pass a freshly-constructed array without retriggering
 * the init effect.
 */

import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";

import { cn } from "@/lib/cn";

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Extra extensions appended after defaults. Stable identity preferred but a
      changing reference will not retrigger init — see `extensionsRef`. */
  extensions?: readonly Extension[];
  /** Surface a setter so parent code can run imperative ops (e.g. flush
      saves before unmount, focus on click). */
  onReady?: (view: EditorView) => void;
  className?: string;
  ariaLabel?: string;
}

export function CodeMirrorView({
  value,
  onChange,
  extensions,
  onReady,
  className,
  ariaLabel,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const extensionsRef = useRef<readonly Extension[] | undefined>(extensions);
  extensionsRef.current = extensions;

  useEffect(() => {
    if (!hostRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          EditorView.lineWrapping,
          // suppress line numbers — markdown notes feel better without
          lineNumbers({ formatNumber: () => "" }),
          editorTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          ...(extensionsRef.current ?? []),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    onReady?.(view);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount-only init; subsequent value/extensions changes handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value into the editor when it diverges. Compare strings
  // up front so we don't emit no-op transactions on every keystroke.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      // Preserve scroll position; cursor is reset to start which is fine
      // because external value changes mean a new node has been loaded.
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={cn("cm-host", className)}
      aria-label={ariaLabel}
    />
  );
}

// Forest-toned editor theme. Keeps the chrome minimal — gutters hidden,
// selection in accent, focused content in deep ink. Detailed tokens come
// later if/when we move beyond `defaultHighlightStyle`.
const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--color-forest-900)",
    fontFamily: "var(--font-sans)",
    fontSize: "15px",
    lineHeight: "1.65",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-content": {
    padding: "1.25rem 0",
    caretColor: "var(--color-accent)",
  },
  ".cm-line": {
    paddingInline: 0,
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--color-accent)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "rgba(212, 122, 93, 0.18)",
    },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
});
