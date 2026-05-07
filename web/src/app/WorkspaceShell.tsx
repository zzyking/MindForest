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
  const toggleSidebar = useWorkspaceUI((s) => s.toggleSidebar);

  // Workspace-level keyboard shortcuts. Bound at the shell so leaf
  // components don't have to re-register on every nav.
  //   Cmd/Ctrl+K  → search palette
  //   Cmd/Ctrl+\  → toggle sidebar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchPalette(true);
        return;
      }
      if (cmd && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearchPalette, toggleSidebar]);

  return (
    <div className="bg-noise relative flex h-screen flex-col bg-forest-50 text-forest-900">
      {/* Skip link — invisible until focused via Tab. Lets keyboard
          users jump past the sidebar and into the main editor pane. */}
      <a
        href="#main-content"
        className={cn(
          "sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50",
          "focus:bg-forest-800 focus:text-sand-100 focus:rounded-md focus:px-3 focus:py-2 focus:text-sm focus:font-medium",
        )}
      >
        Skip to main content
      </a>
      <div className="flex flex-1 overflow-hidden">
        <aside
          className={cn(
            "border-forest-100 bg-sand-100/70 overflow-hidden border-r backdrop-blur-md transition-[width] duration-300 ease-out",
            sidebarOpen ? "w-72" : "w-0",
          )}
          aria-hidden={!sidebarOpen}
          aria-label="Topics and nodes"
        >
          <Sidebar />
        </aside>
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto">
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
