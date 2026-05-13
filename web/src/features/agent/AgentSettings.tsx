/**
 * AgentSettings — runtime-editable LLM provider configuration.
 *
 * Open from the dock. The dialog GETs the masked agent config view
 * (`AgentConfigView`: provider + base_url + model + `api_key_set` +
 * `api_key_hint`), lets the user edit, and PUTs an `AgentConfigUpdate`.
 * Plaintext API keys never enter the wire on read — the server stores
 * them in the OS keychain (macOS Keychain) and only ever returns a
 * fingerprint like `sk-…1234`.
 *
 * The api_key SecretField runs a three-state machine:
 *   - **locked**: backend has a key on file. Shows "Saved · sk-…1234"
 *     plus Replace / Clear affordances. The PUT omits the field.
 *   - **editing**: input box visible. The user typed something (or
 *     never had a key). PUT sends the string verbatim, or — if the
 *     box is empty — omits the field (so users who tweak base_url
 *     without touching the key don't accidentally drop it).
 *   - **cleared**: user pressed Clear. UI shows "Will clear on save".
 *     PUT sends explicit `null` to delete from the keychain.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { ApiError, getAgentConfig, getAgentStatus, putAgentConfig } from "@/lib/api";
import { useFocusTrap } from "@/lib/useFocusTrap";
import type { AgentConfigUpdate, AgentConfigView, AgentProvider } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

const PROVIDERS: { id: AgentProvider; label: string; hint: string }[] = [
  {
    id: "auto",
    label: "Auto-detect",
    hint: "Pick OpenAI if the openai key is set, then Anthropic, else stub.",
  },
  {
    id: "stub",
    label: "Stub",
    hint: "Canned offline response. Useful when you just want to exercise the UI.",
  },
  {
    id: "openai",
    label: "OpenAI-compatible",
    hint: "OpenAI, DeepSeek, Groq, Together, vLLM, Ollama. Anything that speaks /v1/chat/completions.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    hint: "Claude /v1/messages.",
  },
];

const PRESETS: Record<string, { base_url: string; modelHint: string }> = {
  openai: { base_url: "https://api.openai.com/v1", modelHint: "gpt-4o-mini" },
  deepseek: { base_url: "https://api.deepseek.com", modelHint: "deepseek-chat" },
  groq: { base_url: "https://api.groq.com/openai/v1", modelHint: "llama-3.1-70b-versatile" },
  ollama: { base_url: "http://localhost:11434/v1", modelHint: "llama3.2" },
};

/**
 * SecretField state machine. The three variants map onto distinct PUT
 * payloads — see `secretToBody`. Keeping the discriminator on `kind`
 * makes the UI render decision a flat switch rather than nested
 * booleans on the original config view.
 */
type SecretEdit =
  | { kind: "locked"; hint: string }
  | { kind: "editing"; value: string }
  | { kind: "cleared" };

function secretFromView(
  view: { api_key_set: boolean; api_key_hint: string | null } | null,
): SecretEdit {
  if (view?.api_key_set && view.api_key_hint) {
    return { kind: "locked", hint: view.api_key_hint };
  }
  return { kind: "editing", value: "" };
}

/**
 * Map the secret edit state onto the JSON value sent in PUT body.
 * `undefined` → JSON.stringify drops the field → server reads "no
 * change". `null` → explicit clear. String → set.
 */
function secretToBody(s: SecretEdit): string | null | undefined {
  switch (s.kind) {
    case "locked":
      return undefined;
    case "cleared":
      return null;
    case "editing":
      // Empty input = "I haven't typed anything", not "I want it gone".
      // Use Clear for the latter — the destructive intent should be a
      // distinct gesture, never the side-effect of leaving a box blank.
      return s.value ? s.value : undefined;
  }
}

export function AgentSettings({ open, onClose }: Props) {
  const [view, setView] = useState<AgentConfigView | null>(null);
  const [provider, setProvider] = useState<AgentProvider>("auto");
  // Per-provider editable scratch state. Initialised from `view` on load
  // and reset whenever the dialog re-opens — the GET round-trip is the
  // source of truth for what's been saved.
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
  const [openaiModel, setOpenaiModel] = useState("");
  const [openaiSecret, setOpenaiSecret] = useState<SecretEdit>({ kind: "editing", value: "" });
  const [anthropicModel, setAnthropicModel] = useState("");
  const [anthropicSecret, setAnthropicSecret] = useState<SecretEdit>({
    kind: "editing",
    value: "",
  });

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  const hydrate = useCallback((v: AgentConfigView) => {
    setView(v);
    setProvider(v.provider);
    setOpenaiBaseUrl(v.openai.base_url ?? "");
    setOpenaiModel(v.openai.model ?? "");
    setOpenaiSecret(secretFromView(v.openai));
    setAnthropicModel(v.anthropic.model ?? "");
    setAnthropicSecret(secretFromView(v.anthropic));
  }, []);

  // Load config every time the dialog opens — the file might have been
  // edited externally between opens (e.g. `MINDFOREST_AGENT_PROVIDER`
  // env changes for the standalone dev binary), so we don't trust an
  // in-memory cache here.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getAgentConfig(), getAgentStatus()])
      .then(([v, s]) => {
        if (!cancelled) {
          hydrate(v);
          setBackend(s.backend);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(toMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, hydrate]);

  const onSave = useCallback(async () => {
    if (!view) return;
    const body: AgentConfigUpdate = {
      provider,
      openai: {
        base_url: openaiBaseUrl || null,
        model: openaiModel || null,
      },
      anthropic: {
        model: anthropicModel || null,
      },
    };
    // Triple-state api_key — see `secretToBody`. We mutate the body
    // post-construction so the `undefined` arm cleanly drops the field
    // (object-literal `undefined` properties survive JSON.stringify
    // serialization differently from missing properties only in older
    // engines, but the spec says they don't — leaving it explicit).
    const openaiKey = secretToBody(openaiSecret);
    if (openaiKey !== undefined) body.openai.api_key = openaiKey;
    const anthropicKey = secretToBody(anthropicSecret);
    if (anthropicKey !== undefined) body.anthropic.api_key = anthropicKey;

    setSaving(true);
    setError(null);
    try {
      const res = await putAgentConfig(body);
      setBackend(res.backend);
      // Re-fetch the canonical view so the SecretField transitions out
      // of `editing` / `cleared` and back into `locked` reflecting what
      // the server actually persisted.
      const fresh = await getAgentConfig();
      hydrate(fresh);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setSaving(false);
    }
  }, [
    view,
    provider,
    openaiBaseUrl,
    openaiModel,
    openaiSecret,
    anthropicModel,
    anthropicSecret,
    hydrate,
  ]);

  // ESC dismisses the dialog — required affordance for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Agent settings"
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-forest-900/50 px-4 py-8",
        "animate-[fade-in_180ms_ease-out_both]",
      )}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          "shadow-xl border-forest-200 bg-forest-50 max-h-[85vh] w-full max-w-lg",
          "flex flex-col gap-4 overflow-y-auto rounded-xl border p-5 focus:outline-none",
          "animate-[scale-in_220ms_cubic-bezier(0.2,0.8,0.2,1)_both]",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between">
          <div>
            <h2 className="text-forest-900 font-serif text-xl">Agent</h2>
            <p className="text-forest-500 text-xs">
              {backend
                ? `Active backend: ${backend}`
                : "Pick a provider and stash the API key here."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="text-forest-400 hover:text-forest-700 -mr-1 -mt-1 px-2 py-1 text-xl leading-none"
          >
            ×
          </button>
        </header>

        {loading || !view ? (
          <p className="text-forest-400 py-6 text-center text-sm">
            {error ? `Error: ${error}` : "Loading…"}
          </p>
        ) : (
          <div className="flex flex-col gap-5 text-sm">
            <Section label="Provider">
              <div className="flex flex-col gap-1.5">
                {PROVIDERS.map((p) => (
                  <label
                    key={p.id}
                    className={cn(
                      "border-forest-200 flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2",
                      provider === p.id ? "bg-forest-100 border-forest-400" : "hover:bg-forest-50",
                    )}
                  >
                    <input
                      type="radio"
                      name="provider"
                      checked={provider === p.id}
                      onChange={() => setProvider(p.id)}
                      className="accent-forest-700 mt-0.5"
                    />
                    <span>
                      <span className="text-forest-900 block font-medium">{p.label}</span>
                      <span className="text-forest-500 text-xs">{p.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Section>

            {(provider === "openai" || provider === "auto") && (
              <Section label="OpenAI-compatible">
                <PresetRow
                  onPick={(preset) => {
                    setOpenaiBaseUrl(PRESETS[preset]!.base_url);
                  }}
                />
                <Field
                  label="Base URL"
                  placeholder="https://api.openai.com/v1"
                  value={openaiBaseUrl}
                  onChange={setOpenaiBaseUrl}
                />
                <Field
                  label="Model"
                  placeholder="gpt-4o-mini"
                  value={openaiModel}
                  onChange={setOpenaiModel}
                />
                <SecretField
                  label="API key"
                  state={openaiSecret}
                  onChange={setOpenaiSecret}
                  placeholder="sk-…"
                  envFallback="OPENAI_API_KEY"
                />
              </Section>
            )}

            {(provider === "anthropic" || provider === "auto") && (
              <Section label="Anthropic">
                <Field
                  label="Model"
                  placeholder="claude-sonnet-4-6"
                  value={anthropicModel}
                  onChange={setAnthropicModel}
                />
                <SecretField
                  label="API key"
                  state={anthropicSecret}
                  onChange={setAnthropicSecret}
                  placeholder="sk-ant-…"
                  envFallback="ANTHROPIC_API_KEY"
                />
              </Section>
            )}

            {error && <div className="text-accent text-xs">{error}</div>}
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 border-forest-200 border-t pt-3">
          <button
            type="button"
            onClick={onClose}
            className="text-forest-600 hover:text-forest-900 px-3 py-1 text-sm"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!view || saving}
            className="bg-forest-800 text-sand-100 hover:bg-forest-700 disabled:opacity-60 rounded-full px-4 py-1.5 text-sm"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-forest-500 text-[10px] font-medium uppercase tracking-wide">{label}</h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

function Field({ label, value, onChange, placeholder }: FieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-forest-500 text-xs">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="border-forest-200 bg-sand-100 placeholder:text-forest-400 focus:border-forest-500 rounded-md border px-3 py-1.5 text-sm focus:outline-none"
      />
    </div>
  );
}

interface SecretFieldProps {
  label: string;
  state: SecretEdit;
  onChange: (next: SecretEdit) => void;
  placeholder?: string;
  envFallback?: string;
}

function SecretField({ label, state, onChange, placeholder, envFallback }: SecretFieldProps) {
  const id = useId();
  const hintId = useId();
  const [visible, setVisible] = useState(false);

  // Locked view: show the masked fingerprint, plus Replace / Clear
  // affordances. The key never re-enters the DOM as plaintext from
  // this branch — the user has to deliberately switch into edit mode
  // before they can see or change the value.
  if (state.kind === "locked") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-forest-500 text-xs">{label}</span>
        <div
          className={cn(
            "border-forest-200 bg-sand-100 flex items-center justify-between gap-2",
            "rounded-md border px-3 py-1.5 font-mono text-sm",
          )}
        >
          <span className="text-forest-700 truncate">
            <span className="text-forest-400 mr-1.5 text-[10px] not-italic tracking-wide">
              SAVED
            </span>
            {state.hint}
          </span>
          <span className="flex flex-none gap-2">
            <button
              type="button"
              onClick={() => onChange({ kind: "editing", value: "" })}
              className="text-forest-600 hover:text-forest-900 text-xs"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => onChange({ kind: "cleared" })}
              className="text-accent text-xs hover:underline"
            >
              Clear
            </button>
          </span>
        </div>
      </div>
    );
  }

  // Cleared view: confirm the destructive intent and give the user an
  // Undo before they commit by pressing Save.
  if (state.kind === "cleared") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-forest-500 text-xs">{label}</span>
        <div
          className={cn(
            "border-rust-300 bg-rust-50 flex items-center justify-between gap-2",
            "rounded-md border px-3 py-1.5 text-sm",
          )}
          role="status"
        >
          <span className="text-rust-700">Will clear on save</span>
          <button
            type="button"
            // Undoing a `cleared` action returns to `editing` empty —
            // the original hint isn't recoverable from this scope, and
            // re-fetching just to enable an undo is more plumbing than
            // it's worth. Save without typing anything = keep current.
            onClick={() => onChange({ kind: "editing", value: "" })}
            className="text-forest-600 hover:text-forest-900 text-xs"
          >
            Undo
          </button>
        </div>
      </div>
    );
  }

  // Editing view: standard input with show/hide and an env-fallback hint
  // when no value is typed yet.
  return (
    <div className="flex flex-col gap-1">
      <span className="text-forest-500 flex items-center justify-between text-xs">
        <label htmlFor={id}>{label}</label>
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          className="text-forest-400 hover:text-forest-700 text-[10px] uppercase tracking-wide"
        >
          {visible ? "Hide" : "Show"}
        </button>
      </span>
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={state.value}
        onChange={(e) => onChange({ kind: "editing", value: e.target.value })}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={envFallback && !state.value ? hintId : undefined}
        className="border-forest-200 bg-sand-100 placeholder:text-forest-400 focus:border-forest-500 rounded-md border px-3 py-1.5 font-mono text-sm focus:outline-none"
      />
      {envFallback && !state.value && (
        <span id={hintId} className="text-forest-400 text-[10px]">
          Empty → fall back to <code className="font-mono">{envFallback}</code>.
        </span>
      )}
    </div>
  );
}

function PresetRow({ onPick }: { onPick: (preset: keyof typeof PRESETS) => void }) {
  return (
    <div className="text-forest-400 flex flex-wrap items-center gap-1 text-[10px]">
      <span>Preset:</span>
      {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPick(p)}
          className="border-forest-200 text-forest-500 hover:bg-forest-50 rounded-full border px-2 py-0.5 capitalize"
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function toMessage(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
