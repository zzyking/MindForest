/**
 * Persistent layout. Renders floating sidebar + dock + search palette
 * around an `<Outlet />`-driven main area. Mounted at the router's root
 * so it survives every per-node navigation.
 *
 * L1+: the sidebar is a **floating panel** (like the Dock) — it does not
 * take a grid column. Main stays full-width so the field never reflows
 * when the outline opens/closes. Open/close is compositor-only
 * (`translate-x`), matching Dock / AgentPromptBar motion.
 */

import { useEffect } from "react";

import { cn } from "@/lib/cn";
import { useWorkspaceUI } from "@/stores/workspaceUI";
import { Dock } from "@/ui/Dock";
import { Sidebar } from "@/ui/Sidebar";
import { AgentPromptBar } from "@/features/agent/AgentPromptBar";
import { AgentSettings } from "@/features/agent/AgentSettings";
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
  const setSidebar = useWorkspaceUI((s) => s.setSidebar);
  const agentSettingsOpen = useWorkspaceUI((s) => s.agentSettingsOpen);
  const setAgentSettings = useWorkspaceUI((s) => s.setAgentSettings);

  // Workspace-level keyboard shortcuts. Bound at the shell so leaf
  // components don't have to re-register on every nav.
  //   Cmd/Ctrl+K  → search palette
  //   Cmd/Ctrl+\  → toggle sidebar
  //   Cmd/Ctrl+,  → agent settings
  //   Esc         → close floating sidebar (when open, and not typing)
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
      if (cmd && e.key === ",") {
        e.preventDefault();
        setAgentSettings(true);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearchPalette, toggleSidebar, setAgentSettings]);

  return (
    <div className="bg-noise relative flex h-screen flex-col bg-forest-50 text-forest-900">
      {/* Skip link — invisible until focused via Tab. Lets keyboard
          users jump past the sidebar and into the main pane. */}
      <a
        href="#main-content"
        className={cn(
          "sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50",
          "focus:bg-forest-800 focus:text-sand-100 focus:rounded-md focus:px-3 focus:py-2 focus:text-sm focus:font-medium",
        )}
      >
        Skip to main content
      </a>
      {/* Window drag affordance. With TitleBarStyle::Overlay there's no
          system titlebar to grab — this invisible strip across the top
          ~32px makes the same area draggable. `left-[78px]` starts the
          strip after the traffic lights. */}
      <div
        data-tauri-drag-region
        aria-hidden
        className="absolute left-[78px] right-0 top-0 z-30 h-8"
      />

      {/* Main is always full-width — field never reflows for chrome. */}
      <main
        id="main-content"
        tabIndex={-1}
        className="relative min-h-0 min-w-0 flex-1 overflow-y-auto pt-2 [contain:layout_paint] [scrollbar-gutter:stable_both-edges]"
      >
        <ModelDownloadCard />
        {children}
      </main>

      {/* Floating sidebar — slides in from the left over the field.
          translate-x only (compositor); no grid-track animation. */}
      <aside
        aria-hidden={!sidebarOpen}
        aria-label="Topics and nodes"
        inert={!sidebarOpen}
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 z-40 flex items-stretch p-3 pt-10 pb-20",
          "transition-transform duration-[350ms] ease-out will-change-transform resize-keep-transform",
          sidebarOpen ? "translate-x-0" : "-translate-x-[calc(100%+0.75rem)]",
        )}
      >
        <div
          className={cn(
            "pointer-events-auto flex h-full w-[var(--spacing-sidebar)] flex-col overflow-hidden",
            "shadow-glass border-forest-200 bg-sand-100/85 rounded-2xl border backdrop-blur-md",
            "[-webkit-font-smoothing:antialiased] [contain:layout_paint]",
          )}
        >
          <Sidebar />
        </div>
      </aside>

      {/* Soft scrim while sidebar is open — click dismisses. Does not
          dim the field heavily; just captures outside clicks. */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="absolute inset-0 z-30 cursor-default border-0 bg-transparent"
          onClick={() => setSidebar(false)}
        />
      )}

      {/* Bottom chrome — centres on the full window (main is full-bleed). */}
      <DraftOverlay />
      <AgentPromptBar />
      <Dock />
      <SearchPalette />
      <AgentSettings open={agentSettingsOpen} onClose={() => setAgentSettings(false)} />
    </div>
  );
}
