/**
 * Live-preview decorations for the markdown editor.
 *
 * "Live preview" here means "the source stays as plain text, but the
 * Lezer markdown grammar's tags get visually rich CSS so headings,
 * emphasis, code, and links *look* like the rendered version while
 * remaining editable in place" — same UX as Obsidian's Live Preview
 * mode and Typora's seamless edit. We don't try to hide the markup
 * tokens (`#`, `**`, etc.) — the user keeps full control over what's
 * actually in the document.
 *
 * Implementation is pure HighlightStyle + theme; no decorations or view
 * plugins. Lezer tags from `@codemirror/lang-markdown` are mapped to
 * font sizes and weights that match the corresponding `.prose` heading
 * sizes the read view uses, so switching modes doesn't reflow the
 * geometry.
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Heading sizes — kept in sync with the `.prose` overrides in
// globals.css so Write / Source / Read all agree on geometry.
const H1 = "1.875rem"; // 30px
const H2 = "1.5rem"; //   24px
const H3 = "1.25rem"; //  20px
const H4 = "1.125rem"; // 18px
const H5 = "1rem"; //     16px (= body)
const H6 = "0.875rem"; // 14px

const livePreviewHighlight = HighlightStyle.define([
  {
    tag: t.heading1,
    fontFamily: "var(--font-serif)",
    fontSize: H1,
    fontWeight: "700",
    color: "var(--color-forest-900)",
    lineHeight: "1.25",
  },
  {
    tag: t.heading2,
    fontFamily: "var(--font-serif)",
    fontSize: H2,
    fontWeight: "700",
    color: "var(--color-forest-900)",
    lineHeight: "1.3",
  },
  {
    tag: t.heading3,
    fontFamily: "var(--font-serif)",
    fontSize: H3,
    fontWeight: "600",
    color: "var(--color-forest-800)",
    lineHeight: "1.35",
  },
  {
    tag: t.heading4,
    fontSize: H4,
    fontWeight: "600",
    color: "var(--color-forest-800)",
  },
  {
    tag: t.heading5,
    fontSize: H5,
    fontWeight: "600",
    color: "var(--color-forest-700)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  {
    tag: t.heading6,
    fontSize: H6,
    fontWeight: "600",
    color: "var(--color-forest-600)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  // Inline emphasis. Markup tokens (`*` / `_` / `**`) keep their
  // weight but take a dimmer colour so the eye reads through them.
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // Code: monospace + a thin coloured background. Lezer tags inline
  // monospace + fenced blocks differently.
  {
    tag: t.monospace,
    fontFamily: "var(--font-mono)",
    fontSize: "0.95em",
    backgroundColor: "rgba(85, 124, 104, 0.12)",
    padding: "0 4px",
    borderRadius: "3px",
  },
  // Links: underline + accent. The bracket / paren markup tokens are
  // kept visible (not hidden) so the user can edit URLs in place.
  { tag: t.link, color: "var(--color-accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--color-accent)" },
  // Blockquote text — italic + indent + colour shift.
  { tag: t.quote, fontStyle: "italic", color: "var(--color-forest-700)" },
  // List markers (`-`, `*`, numerics) get the accent colour so the
  // hierarchy reads at a glance.
  { tag: t.list, color: "var(--color-forest-900)" },
  { tag: t.processingInstruction, color: "var(--color-forest-400)" },
  // ATX `#` markers and other syntax tokens.
  { tag: t.meta, color: "var(--color-forest-400)" },
]);

// Minor theme tweaks layered on top of `editorTheme` (the workspace
// shared theme stays in CodeMirrorView). Force long heading lines to
// wrap aggressively — the bigger heading font means a long title can
// outrun the column even with EditorView.lineWrapping on, because
// soft-wrap won't break inside an unbroken word run. `overflow-wrap:
// anywhere` lets the browser break mid-word as a last resort.
const livePreviewTheme = EditorView.theme({
  "&": {
    overflow: "hidden",
  },
  ".cm-scroller": {
    overflowX: "hidden",
  },
  ".cm-content": {
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  },
  ".cm-line": {
    paddingTop: "1px",
    paddingBottom: "1px",
  },
});

/**
 * Extension array for the Write (live preview) mode. Spread into the
 * CodeMirrorView `extensions` prop.
 */
export const livePreviewExtensions: Extension[] = [
  syntaxHighlighting(livePreviewHighlight),
  livePreviewTheme,
];
