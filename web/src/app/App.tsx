import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";

// Phase 1 scaffold: validates the toolchain (Vite + React 19 + Tailwind v4
// + token CSS) and pings the Rust API so a broken backend is visible at
// boot. Real router / stores / workspace shell land in tasks #4 and #9.

type ApiHealth =
  | { state: "loading" }
  | { state: "ok" }
  | { state: "error"; message: string };

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8787";

export function App() {
  const [health, setHealth] = useState<ApiHealth>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/health`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ ok: boolean }>;
      })
      .then((body) => {
        if (cancelled) return;
        setHealth(body.ok ? { state: "ok" } : { state: "error", message: "ok=false" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHealth({
          state: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="bg-noise relative min-h-screen bg-forest-50 text-forest-900">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 py-16 text-center">
        <h1 className="font-serif text-6xl font-medium tracking-tight">MindForest</h1>
        <p className="text-forest-600 max-w-prose text-lg">
          v2 scaffold &mdash; Vite + React 19 + Tailwind v4. Workspace UI ships in tasks
          {" "}<code className="font-mono">#4</code> and{" "}
          <code className="font-mono">#9</code>.
        </p>
        <HealthBadge health={health} />
      </div>
    </main>
  );
}

function HealthBadge({ health }: { health: ApiHealth }) {
  const palette = {
    loading: "border-forest-300 text-forest-500",
    ok: "border-forest-500 text-forest-700",
    error: "border-accent text-accent",
  } as const;
  const label = {
    loading: "Pinging API…",
    ok: `API reachable at ${API_BASE}`,
    error: `API unreachable at ${API_BASE}`,
  } as const;
  return (
    <div
      className={cn(
        "shadow-glass rounded-full border bg-sand-100/80 px-4 py-2 font-mono text-sm backdrop-blur-md",
        palette[health.state],
      )}
    >
      <span className="mr-2">●</span>
      {label[health.state]}
      {health.state === "error" && (
        <span className="text-forest-500 ml-2">({health.message})</span>
      )}
    </div>
  );
}
