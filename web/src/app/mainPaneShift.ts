/**
 * The floating bottom chrome (Dock, AgentPromptBar, DraftOverlay)
 * centres over the MAIN PANE, not the window — when the sidebar is
 * open at lg+ the centred axis shifts right by half the sidebar width
 * (derived from --spacing-sidebar so a width change can't desync it).
 * Shared here so the pieces can't drift apart.
 *
 * translate-x is compositor-only and composites cleanly on top of the
 * sidebar's grid-track transition (see WorkspaceShell). Callers pair it
 * with `transition-transform duration-[350ms]` so all sidebar-tracking
 * tweens finish in lockstep with the grid track.
 */

import { useMediaQuery } from "@/lib/useMediaQuery";
import { useWorkspaceUI } from "@/stores/workspaceUI";

export function useMainPaneShiftClass(): string {
  const sidebarOpen = useWorkspaceUI((s) => s.sidebarOpen);
  const isLg = useMediaQuery("(min-width: 1024px)");
  return sidebarOpen && isLg
    ? "translate-x-[calc(var(--spacing-sidebar)/2)]"
    : "translate-x-0";
}
