import { useEffect, useState } from "react";

import { getAgentStatus } from "@/lib/api";

/**
 * Fetches the active backend label from /v1/agent/status. Re-fetches
 * whenever the window regains focus so external config changes (env var
 * edits, file edits) surface without a full reload.
 */
export function useAgentStatus(): string | null {
  const [backend, setBackend] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      getAgentStatus()
        .then((r) => { if (!cancelled) setBackend(r.backend); })
        .catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return backend;
}
