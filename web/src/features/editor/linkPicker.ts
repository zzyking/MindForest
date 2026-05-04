/**
 * CM6 autocomplete extension that triggers on `[[` and queries the API's
 * `/v1/search` for matching nodes. Selecting a candidate inserts
 * `[[Title|<id>]]` — the renderer (read mode) resolves the trailing
 * `<id>` against the node store; the bracket text is just for human
 * readability, since titles can drift.
 *
 * Why this is its own file: CM extensions are pure data + functions
 * (no React), and keeping them apart from `NodeEditor.tsx` prevents
 * accidental coupling to component state. The only inputs are the
 * current topic (passed through closure) and the API surface.
 */

import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

import { search } from "@/lib/api";
import type { TopicId } from "@/lib/types";

interface LinkPickerOptions {
  /** Topic to bias the search toward. `undefined` = global search. */
  currentTopic?: TopicId;
  /** Node ids to filter out (e.g. the editing node itself, to prevent self-links). */
  excludeIds?: ReadonlyArray<string>;
  /** Max results from `/v1/search`. Default 8 — enough to show without
      overwhelming the popover. */
  limit?: number;
}

/**
 * Returns the CM6 extension. Build a fresh instance per editor mount;
 * the closed-over `excludeIds` will be re-read on every completion call.
 */
export function linkPicker(opts: LinkPickerOptions = {}) {
  const limit = opts.limit ?? 8;
  return autocompletion({
    override: [
      async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        // Match `[[<query>` ending at the cursor. The query may be empty
        // if the user just typed `[[`. Stop at line breaks or another `[`
        // so nested brackets don't pull a runaway match.
        const match = ctx.matchBefore(/\[\[[^\[\]\n]*/);
        if (!match) return null;
        const query = match.text.slice(2); // strip the leading `[[`

        // Don't fire on every empty trigger if the user hasn't pressed
        // explicit (Cmd+Space) — but DO fire on the first `[[` so the
        // popover appears immediately.
        if (!ctx.explicit && query.length === 0 && match.text !== "[[") {
          return null;
        }

        let hits;
        try {
          hits = await search({
            q: query.trim() || "*",
            topic: opts.currentTopic,
            k: limit,
          });
        } catch {
          // Network blip — let the user keep typing without a CM error.
          return null;
        }

        const exclude = new Set(opts.excludeIds ?? []);
        const options = hits
          .filter((h) => !exclude.has(h.id))
          .map((h) => ({
            label: h.title,
            detail: h.topic,
            apply: `[[${h.title}|${h.id}]]`,
            type: "node",
            // Use the FTS bm25 as the relative ordering hint.
            boost: h.score,
          }));

        return {
          from: match.from,
          to: ctx.pos,
          options,
          // Keep the popover open as the user keeps typing the query.
          validFor: /^\[\[[^\[\]\n]*$/,
          filter: false,
        };
      },
    ],
  });
}
