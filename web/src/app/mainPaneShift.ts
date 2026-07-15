/**
 * Horizontal shift for floating bottom chrome (Dock, AgentPromptBar,
 * DraftOverlay).
 *
 * Historically this offset tracked the sidebar grid column so chrome
 * stayed centred on the main pane. The sidebar is now a floating
 * overlay (WorkspaceShell) — main is always full-width, so the shift
 * is always zero. The hook remains so call sites stay stable if a
 * future chrome offset returns.
 */

export function useMainPaneShiftClass(): string {
  return "translate-x-0";
}
