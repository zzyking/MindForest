/**
 * AgentSettings — runtime-editable LLM provider configuration.
 *
 * Open from the sidebar's "Agent" footer. The dialog GETs the current
 * `AgentConfig` from the API, lets the user pick provider + model +
 * api_key + base_url, and PUTs the result. The server rebuilds its
 * proposer in place so the next agent prompt uses the new backend
 * without restarting.
 *
 * Storage: `<data_dir>/agent.json`, written 0600 on unix. The api_key
 * never leaves the user's machine — the only place it crosses the wire
 * is the loopback HTTP between this UI and the in-process API.
 */

import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { ApiError, getAgentConfig, putAgentConfig } from "@/lib/api";
import type { AgentConfig, AgentProvider } from "@/lib/types";

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
    hint: "Canned offline response — useful when you just want to exercise the UI.",
  },
  {
    id: "openai",
    label: "OpenAI-compatible",
    hint: "OpenAI, DeepSeek, Groq, Together, vLLM, Ollama — anything that speaks /v1/chat/completions.",
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

export function AgentSettings({ open, onClose }: Props) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [showOpenAIKey, setShowOpenAIKey] = useState(false);
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);

  // Load config every time the dialog opens — the file might have been
  // edited externally between opens (e.g. via the seed.mjs path or env
  // changes), so we don't trust an in-memory cache here.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getAgentConfig()
      .then((c) => {
        if (!cancelled) setConfig(c);
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
  }, [open]);

  const onSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const res = await putAgentConfig(config);
      setBackend(res.backend);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setSaving(false);
    }
  }, [config]);

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
        className={cn(
          "shadow-xl border-forest-200 bg-forest-50 max-h-[85vh] w-full max-w-lg",
          "flex flex-col gap-4 overflow-y-auto rounded-xl border p-5",
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

        {loading || !config ? (
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
                      config.provider === p.id
                        ? "bg-forest-100 border-forest-400"
                        : "hover:bg-forest-50",
                    )}
                  >
                    <input
                      type="radio"
                      name="provider"
                      checked={config.provider === p.id}
                      onChange={() => setConfig({ ...config, provider: p.id })}
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

            {(config.provider === "openai" || config.provider === "auto") && (
              <Section label="OpenAI-compatible">
                <PresetRow
                  onPick={(preset) =>
                    setConfig({
                      ...config,
                      openai: {
                        ...config.openai,
                        base_url: PRESETS[preset]!.base_url,
                      },
                    })
                  }
                />
                <Field
                  label="Base URL"
                  placeholder="https://api.openai.com/v1"
                  value={config.openai.base_url ?? ""}
                  onChange={(v) =>
                    setConfig({
                      ...config,
                      openai: { ...config.openai, base_url: v || null },
                    })
                  }
                />
                <Field
                  label="Model"
                  placeholder="gpt-4o-mini"
                  value={config.openai.model ?? ""}
                  onChange={(v) =>
                    setConfig({
                      ...config,
                      openai: { ...config.openai, model: v || null },
                    })
                  }
                />
                <SecretField
                  label="API key"
                  visible={showOpenAIKey}
                  onToggleVisible={() => setShowOpenAIKey((v) => !v)}
                  value={config.openai.api_key ?? ""}
                  onChange={(v) =>
                    setConfig({
                      ...config,
                      openai: { ...config.openai, api_key: v || null },
                    })
                  }
                  placeholder="sk-…"
                  envFallback="OPENAI_API_KEY"
                />
              </Section>
            )}

            {(config.provider === "anthropic" || config.provider === "auto") && (
              <Section label="Anthropic">
                <Field
                  label="Model"
                  placeholder="claude-sonnet-4-6"
                  value={config.anthropic.model ?? ""}
                  onChange={(v) =>
                    setConfig({
                      ...config,
                      anthropic: { ...config.anthropic, model: v || null },
                    })
                  }
                />
                <SecretField
                  label="API key"
                  visible={showAnthropicKey}
                  onToggleVisible={() => setShowAnthropicKey((v) => !v)}
                  value={config.anthropic.api_key ?? ""}
                  onChange={(v) =>
                    setConfig({
                      ...config,
                      anthropic: { ...config.anthropic, api_key: v || null },
                    })
                  }
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
            disabled={!config || saving}
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
  return (
    <label className="flex flex-col gap-1">
      <span className="text-forest-500 text-xs">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="border-forest-200 bg-sand-100 placeholder:text-forest-400 focus:border-forest-500 rounded-md border px-3 py-1.5 text-sm focus:outline-none"
      />
    </label>
  );
}

interface SecretFieldProps extends FieldProps {
  visible: boolean;
  onToggleVisible: () => void;
  envFallback?: string;
}

function SecretField({
  label,
  value,
  onChange,
  placeholder,
  visible,
  onToggleVisible,
  envFallback,
}: SecretFieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-forest-500 flex items-center justify-between text-xs">
        <span>{label}</span>
        <button
          type="button"
          onClick={onToggleVisible}
          className="text-forest-400 hover:text-forest-700 text-[10px] uppercase tracking-wide"
        >
          {visible ? "Hide" : "Show"}
        </button>
      </span>
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="border-forest-200 bg-sand-100 placeholder:text-forest-400 focus:border-forest-500 rounded-md border px-3 py-1.5 font-mono text-sm focus:outline-none"
      />
      {envFallback && !value && (
        <span className="text-forest-400 text-[10px]">
          Empty → fall back to <code className="font-mono">{envFallback}</code>.
        </span>
      )}
    </label>
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
