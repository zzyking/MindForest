/**
 * Persistent layout. Renders sidebar + dock + search palette around an
 * `<Outlet />`-driven main area. Mounted at the router's root so it
 * survives every per-node navigation.
 *
 * Layout uses CSS Grid with two columns; the sidebar column collapses
 * to 0 when `sidebarOpen` is false (animated via `width` transition).
 * The main area is `overflow-y: auto` so it can scroll independently
 * — Tree / Graph viewports in P2 will host themselves inside it.
 */

import { useEffect } from "react";

import { cn } from "@/lib/cn";
import { useWorkspaceUI } from "@/stores/workspaceUI";
import { Dock } from "@/ui/Dock";
import { Sidebar } from "@/ui/Sidebar";
import { AgentPromptBar } from "@/features/agent/AgentPromptBar";
import { DraftOverlay } from "@/features/agent/DraftOverlay";
import { ModelDownloadCard } from "@/features/embed/ModelDownloadCard";
import { SearchPalette } from "@/features/search/SearchPalette";

interface Props {
  children: React.ReactNode;
}

export function WorkspaceShell({ children }: Props) {
  const sidebarOpen = useWorkspaceUI((s) => s.sidebarOpen);
  const setSearchPalette = useWorkspaceUI((s) => s.setSearchPalette);

  // Cmd/Ctrl+K opens the search palette from anywhere. Bound at the
  // shell so leaf components don't have to re-register on every nav.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearchPalette]);

  return (
    <div className="bg-noise relative flex h-screen flex-col bg-forest-50 text-forest-900">
      <div className="flex flex-1 overflow-hidden">
        <aside
          className={cn(
            "border-forest-100 bg-sand-100/70 overflow-hidden border-r backdrop-blur-md transition-[width] duration-300 ease-out",
            sidebarOpen ? "w-72" : "w-0",
          )}
          aria-hidden={!sidebarOpen}
        >
          <Sidebar />
        </aside>
        <main className="flex-1 overflow-y-auto">
          <ModelDownloadCard />
          {children}
        </main>
        <DraftOverlay />
      </div>
      <AgentPromptBar />
      <Dock />
      <SearchPalette />
    </div>
  );
}
