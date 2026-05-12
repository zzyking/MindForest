/**
 * Trap keyboard focus inside `containerRef` while `enabled` is true.
 *
 * On enable: snapshot the previously focused element, then move focus to
 * the first focusable descendant (or the container itself, if none).
 * Tab / Shift+Tab wrap within the container. On disable, restore focus
 * to the snapshotted element.
 *
 * Pair with `role="dialog" aria-modal="true"` and an Escape handler.
 */

import { useEffect } from "react";

const SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Defer the initial focus so callers can complete their own mount
    // logic (e.g. SearchPalette focusing its input). A 0ms timeout is
    // enough to land after React's commit phase.
    const initialFocus = window.setTimeout(() => {
      if (container.contains(document.activeElement)) return;
      const first = container.querySelector<HTMLElement>(SELECTOR);
      (first ?? container).focus();
    }, 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(SELECTOR),
      ).filter((el) => !el.hasAttribute("inert") && el.offsetParent !== null);
      if (focusable.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !container.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(initialFocus);
      container.removeEventListener("keydown", onKey);
      // Only restore if focus is still inside us (caller may have moved
      // focus elsewhere on close, e.g. via `useFocusNode`).
      if (container.contains(document.activeElement) && previouslyFocused) {
        previouslyFocused.focus();
      }
    };
  }, [enabled, containerRef]);
}
