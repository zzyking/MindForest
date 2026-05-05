/**
 * Embedding-model download banner.
 *
 * Shown at the top of the workspace when:
 *   - the embedder backend is `sidecar` AND
 *   - the local model directory is missing one or more required files
 *
 * Hidden in stub / off mode (no point asking the user to download a
 * model the embedder won't load anyway). Polls `/v1/embed/model/status`
 * once on mount and again after a successful download.
 *
 * The download itself streams `DownloadEvent`s — we keep the latest
 * progress numbers in component state and render a single overall bar
 * plus the current file name. Cancellation aborts the fetch, which
 * closes the SSE channel, which drops the server-side mpsc, which
 * tears the download task down. Any partial files on disk are
 * overwritten by the next attempt.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { ApiError, downloadModel, getModelStatus } from "@/lib/api";
import type { DownloadEvent, ModelStatusResponse } from "@/lib/types";

type Phase =
  | { kind: "idle" }
  | {
      kind: "downloading";
      currentFile: string | null;
      overallSoFar: number;
      overallTotal: number | null;
      filesDone: number;
      totalFiles: number;
    }
  | { kind: "error"; message: string }
  | { kind: "done" };

export function ModelDownloadCard() {
  const [status, setStatus] = useState<ModelStatusResponse | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const cancelRef = useRef<(() => void) | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getModelStatus());
    } catch (e) {
      // Status check failure is silent — the user shouldn't see noise
      // about an admin endpoint they didn't ask about. Logged for
      // debug, but it doesn't escalate.
      // eslint-disable-next-line no-console
      console.warn("[ModelDownloadCard] status fetch failed:", e);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    return () => {
      cancelRef.current?.();
    };
  }, [refreshStatus]);

  const startDownload = useCallback(async () => {
    setPhase({
      kind: "downloading",
      currentFile: null,
      overallSoFar: 0,
      overallTotal: null,
      filesDone: 0,
      totalFiles: 0,
    });
    const { events, cancel } = downloadModel();
    cancelRef.current = cancel;
    try {
      for await (const ev of events) {
        applyEvent(ev, setPhase);
      }
      // Stream exited without a `done` — treat as success only if the
      // last event was `done`; otherwise leave phase as-is.
      void refreshStatus();
    } catch (e) {
      if (e instanceof ApiError) {
        setPhase({ kind: "error", message: e.message });
      } else if ((e as { name?: string }).name === "AbortError") {
        setPhase({ kind: "idle" });
      } else {
        setPhase({ kind: "error", message: String(e) });
      }
    } finally {
      cancelRef.current = null;
    }
  }, [refreshStatus]);

  const stopDownload = useCallback(() => {
    cancelRef.current?.();
  }, []);

  // Don't render unless the embedder genuinely needs the model. Stub /
  // off modes don't read it, so showing a download CTA would be misleading.
  if (!status) return null;
  if (status.embed_mode !== "sidecar") return null;
  if (status.present && phase.kind !== "downloading" && phase.kind !== "error") return null;

  return (
    <div
      role="region"
      aria-label="Embedding model"
      className={cn(
        "border-forest-200 bg-sand-100/85 text-forest-700 shadow-glass mx-4 mt-4",
        "flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm backdrop-blur-md",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-forest-800 font-medium">Embedding model</div>
          <div className="text-forest-500 truncate text-xs">{status.repo_id}</div>
        </div>
        <Action
          phase={phase}
          present={status.present}
          onStart={startDownload}
          onStop={stopDownload}
        />
      </div>
      <Body phase={phase} status={status} />
    </div>
  );
}

interface ActionProps {
  phase: Phase;
  present: boolean;
  onStart: () => void;
  onStop: () => void;
}

function Action({ phase, present, onStart, onStop }: ActionProps) {
  switch (phase.kind) {
    case "downloading":
      return (
        <button
          type="button"
          onClick={onStop}
          className="border-accent text-accent hover:bg-accent/10 rounded-full border px-3 py-1 text-xs"
        >
          Cancel
        </button>
      );
    case "error":
      return (
        <button
          type="button"
          onClick={onStart}
          className="bg-forest-800 text-sand-100 hover:bg-forest-700 rounded-full px-3 py-1 text-xs"
        >
          Retry
        </button>
      );
    case "done":
      return present ? (
        <span className="text-forest-500 text-xs">Installed</span>
      ) : (
        <button
          type="button"
          onClick={onStart}
          className="bg-forest-800 text-sand-100 hover:bg-forest-700 rounded-full px-3 py-1 text-xs"
        >
          Download
        </button>
      );
    default:
      return (
        <button
          type="button"
          onClick={onStart}
          className="bg-forest-800 text-sand-100 hover:bg-forest-700 rounded-full px-3 py-1 text-xs"
        >
          Download
        </button>
      );
  }
}

function Body({ phase, status }: { phase: Phase; status: ModelStatusResponse }) {
  if (phase.kind === "downloading") {
    const pct = phase.overallTotal
      ? Math.min(100, (phase.overallSoFar / phase.overallTotal) * 100)
      : null;
    return (
      <div className="flex flex-col gap-1">
        <div className="text-forest-500 flex items-center justify-between text-xs">
          <span className="truncate">
            {phase.currentFile ? `Downloading ${phase.currentFile}` : "Preparing…"}
          </span>
          <span>
            {phase.filesDone}/{phase.totalFiles || "?"} files
            {pct !== null ? ` · ${pct.toFixed(0)}%` : ""}
          </span>
        </div>
        <div className="bg-forest-100 h-1 overflow-hidden rounded-full">
          <div
            className="bg-accent h-full transition-[width] duration-200"
            style={{ width: pct !== null ? `${pct}%` : "20%" }}
          />
        </div>
      </div>
    );
  }
  if (phase.kind === "error") {
    return <div className="text-accent text-xs">{phase.message}</div>;
  }
  if (phase.kind === "done" && status.present) {
    return <div className="text-forest-500 text-xs">All files present.</div>;
  }
  // Idle and not present: show a one-line summary of what's missing.
  const missing = status.files.filter((f) => !f.present).length;
  return (
    <div className="text-forest-500 text-xs">
      {missing} of {status.files.length} files missing — download to enable semantic search.
    </div>
  );
}

function applyEvent(ev: DownloadEvent, setPhase: (updater: (prev: Phase) => Phase) => void) {
  setPhase((prev) => {
    if (prev.kind !== "downloading") {
      // We landed in a non-downloading state but events keep arriving
      // (e.g. error then progress). Ignore — phase has already moved on.
      if (ev.kind === "started") {
        return {
          kind: "downloading",
          currentFile: null,
          overallSoFar: 0,
          overallTotal: null,
          filesDone: 0,
          totalFiles: ev.total_files,
        };
      }
      return prev;
    }
    switch (ev.kind) {
      case "started":
        return { ...prev, totalFiles: ev.total_files };
      case "file_start":
        return { ...prev, currentFile: ev.name };
      case "progress":
        return {
          ...prev,
          currentFile: ev.name,
          overallSoFar: ev.overall_so_far,
          overallTotal: ev.overall_total,
        };
      case "file_done":
        return { ...prev, filesDone: prev.filesDone + 1 };
      case "done":
        return { kind: "done" };
      case "error":
        return { kind: "error", message: ev.message };
    }
  });
}
