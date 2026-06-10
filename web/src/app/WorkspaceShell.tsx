/**
 * Persistent layout. Renders sidebar + dock + search palette around an
 * `<Outlet />`-driven main area. Mounted at the router's root so it
 * survives every per-node navigation.
 *
 * Layout uses CSS Grid with two columns; the sidebar column collapses
 * from 18rem to 0 when `sidebarOpen` is false. The transition is on
 * `grid-template-columns` rather than `width` on a flex item — same
 * visual result, but a single property on a single container is far
 * cheaper for the browser than a flex+width animation that cascades
 * recalc through every flex item. `contain: layout` on the aside
 * scopes the sidebar's internal reflow during the transition.
 *
 * Dock and AgentPromptBar shift horizontally to track the centred-on-
 * main-pane axis; those use `translate-x` (compositor-only) instead of
 * `padding-left` so they don't pile additional layout work onto the
 * same 300 ms window.
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
  const agentSettingsOpen = useWorkspaceUI((s) => s.agentSettingsOpen);
  const setAgentSettings = useWorkspaceUI((s) => s.setAgentSettings);

  // Workspace-level keyboard shortcuts. Bound at the shell so leaf
  // components don't have to re-register on every nav.
  //   Cmd/Ctrl+K  → search palette
  //   Cmd/Ctrl+\  → toggle sidebar
  //   Cmd/Ctrl+,  → agent settings
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
      {/* Window drag affordance. With TitleBarStyle::Overlay there's no
          system titlebar to grab — this invisible strip across the top
          ~32px makes the same area draggable. `left-[78px]` starts the
          strip after the traffic lights (which AppKit owns and which
          must continue to receive clicks). Requires
          `core:window:allow-start-dragging` in capabilities/default.json
          — without that permission the IPC call silently fails and
          drag stops working. */}
      <div
        data-tauri-drag-region
        aria-hidden
        className="absolute left-[78px] right-0 top-0 z-30 h-8"
      />
      <div
        className={cn(
          "grid flex-1 overflow-hidden",
          // 350ms (vs the typical 300ms for a UI tween) gives the eye
          // a beat to follow the sidebar's collapse to 0 without
          // feeling rushed. Dock + AgentPromptBar use the same duration
          // so the three transitions finish in lockstep. Width comes
          // from --spacing-sidebar (tokens.css), shared with Sidebar
          // and the dock/prompt-bar half-width shift.
          "transition-[grid-template-columns] duration-[350ms] ease-out",
          sidebarOpen ? "grid-cols-[var(--spacing-sidebar)_1fr]" : "grid-cols-[0_1fr]",
        )}
      >
        <aside
          // `contain: layout paint` (was `layout` only) scopes both
          // reflow and paint to the sidebar — during a live window
          // resize the browser doesn't have to invalidate paint
          // regions outside this element, which kills a major source
          // of jitter on left-edge drag.
          className="border-forest-100 bg-sand-100/70 overflow-hidden border-r backdrop-blur-md [contain:layout_paint]"
          aria-hidden={!sidebarOpen}
          aria-label="Topics and nodes"
          // inert removes the collapsed sidebar's descendants from the
          // tab order and the accessibility tree. aria-hidden alone
          // hides from AT but doesn't change keyboard reachability.
          inert={!sidebarOpen}
        >
          <Sidebar />
        </aside>
        <main
          id="main-content"
          tabIndex={-1}
          // `relative` is required for `contain: paint` to take effect
          // (the spec needs a positioning context). `contain: layout
          // paint` keeps the editor / tree / forest panes from
          // pushing their reflow up to the grid root during a live
          // resize — measurable reduction in per-frame compositor work.
          // `pt-2` (8px) keeps every view's first card / toolbar clear
          // of the traffic-light overlay at top-left (the Tauri
          // TitleBarStyle::Overlay window has no system titlebar). The
          // inner scaffold's `py-6` (24px) compounds to 32px above
          // first content, matching the sidebar's `pt-8`.
          className="relative min-w-0 overflow-y-auto pt-2 [contain:layout_paint]"
        >
          <ModelDownloadCard />
          {children}
        </main>
        <DraftOverlay />
      </div>
      <AgentPromptBar />
      <Dock />
      <SearchPalette />
      <AgentSettings open={agentSettingsOpen} onClose={() => setAgentSettings(false)} />
    </div>
  );
}
