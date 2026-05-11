/**
 * Auto-sizing single-field title input. Behaves like an `<input>` but
 * uses a `<textarea>` so long Chinese / multi-line titles wrap instead
 * of horizontally scrolling — a small but persistent v1 papercut.
 *
 * Sizing is driven by `el.scrollHeight` recomputed on every input event;
 * setting `height: auto` first forces the layout to shrink-fit before
 * we measure, otherwise it would only ever grow.
 *
 * box-sizing matters: `el.scrollHeight` reports the content height
 * (padding inclusive, border exclusive). If the textarea is in the
 * Tailwind preflight default `box-sizing: border-box`, setting
 * `height = scrollHeight` makes the *outer* box that tall, so the
 * content area is `scrollHeight − 2·padding − 2·border` — and the last
 * visual line gets clipped. We force `box-content` (content-box) so
 * scrollHeight exactly matches the inner content area we need.
 */

import { useEffect, useRef, type CSSProperties } from "react";

import { cn } from "@/lib/cn";

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Fires on Enter; suppresses newline insertion since titles are
      single-line conceptually even though we render in a textarea. */
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

export function TitleInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  className,
  style,
  ariaLabel,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Resize on value change — nav switches to a longer title would
  // otherwise leave the textarea sized to the previous one until the
  // user types.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    fit(el);
  }, [value]);

  // Resize when the container width changes (e.g. window narrowed) so
  // content that re-wraps gets the correct new height rather than being
  // clipped by overflow-hidden.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fit(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      onInput={(e) => fit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onSubmit?.();
          ref.current?.blur();
        }
      }}
      rows={1}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      style={style}
      className={cn(
        // leading-[1.4] — Crimson Pro at 36px has tall ascenders +
        // descenders that overshoot 1.25–1.3 line-heights and get
        // clipped by `overflow-hidden` below. 1.4 gives the glyphs
        // room without feeling airy.
        "w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-serif text-4xl leading-[1.4] tracking-tight outline-none",
        "box-content",
        "placeholder:text-forest-300",
        className,
      )}
    />
  );
}

/**
 * Resize the textarea to fit its content. `scrollHeight` rounds down to
 * an integer, which can leave a fractional pixel of glyph hanging
 * outside the box (visible as a clipped descender). Add a small buffer
 * — invisible to the eye, robust against the rounding edge cases.
 */
function fit(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 4}px`;
}
