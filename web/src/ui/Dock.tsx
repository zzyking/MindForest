/**
 * Floating bottom dock. Holds workspace-wide affordances: sidebar
 * toggle, view-mode segmented switch (editor / tree / forest), search
 * palette opener, and the agent-bar trigger. Sticks to bottom-center so
 * it's reachable from any pointer position without being modal.
 *
 * The view-mode toggle only flips the workspace's pane; the route stays
 * the same. Picking a node from tree/forest navigates back to editor by
 * default — see `useFocusNode` callers in TreeView / ForestView.
 *
 * The agent bar rests collapsed: at rest the dock is the only chrome
 * row, and the Sparkles trigger (or `/` / ⌘I) expands the bar above it
 * (`agentBarOpen` in workspaceUI).
 *
 * Collapse behaviour: both this dock and the AgentPromptBar slide out
 * via `dockExpanded` in workspaceUI. A small reveal pill at the
 * bottom-right lets the user bring them back.
 */

import { ChevronDown, ChevronUp, PanelLeft, PanelLeftClose, Pencil, Search, Settings, Shrub, Sparkles, Trees } from "lucide-react";

import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useWorkspaceUI, type ViewMode } from "@/stores/workspaceUI";

export function Dock() {
  const sidebarOpen = useWorkspaceUI((s) => s.sidebarOpen);
  const toggleSidebar = useWorkspaceUI((s) => s.toggleSidebar);
  const setSearchPalette = useWorkspaceUI((s) => s.setSearchPalette);
  const setAgentSettings = useWorkspaceUI((s) => s.setAgentSettings);
  const viewMode = useWorkspaceUI((s) => s.viewMode);
  const setViewMode = useWorkspaceUI((s) => s.setViewMode);
  const dockExpanded = useWorkspaceUI((s) => s.dockExpanded);
  const toggleDock = useWorkspaceUI((s) => s.toggleDock);
  const agentBarOpen = useWorkspaceUI((s) => s.agentBarOpen);
  const toggleAgentBar = useWorkspaceUI((s) => s.toggleAgentBar);
  const isLg = useMediaQuery("(min-width: 1024px)");

  const CurrentViewIcon = VIEW_MODES.find((m) => m.id === viewMode)?.Icon ?? Pencil;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4">

      {/* ── Main dock pill — centred over the main pane ── */}
      <div
        className={cn(
          "flex justify-center will-change-transform",
          // 350ms matches the sidebar grid track transition in
          // WorkspaceShell so the three sidebar-tracking animations
          // (sidebar collapse, dock shift, agent bar shift) finish in
          // lockstep. translate-x is a compositor-only op; the shift
          // is half the sidebar width, derived from --spacing-sidebar
          // so a width change can't desync it. `resize-keep-transform`
          // exempts this tween from the data-resizing freeze so
          // crossing the lg breakpoint mid window-drag still animates
          // (globals.css).
          "transition-transform duration-[350ms] ease-out resize-keep-transform",
          sidebarOpen && isLg
            ? "translate-x-[calc(var(--spacing-sidebar)/2)]"
            : "translate-x-0",
        )}
      >
        <div
          // inert: pointer-events-none alone leaves the hidden buttons
          // keyboard-tabbable; inert removes them from tab order + AT.
          inert={!dockExpanded}
          className={cn(
            "shadow-glass border-forest-200 bg-sand-100/80 pointer-events-auto",
            "flex items-center gap-1 rounded-full border px-2 py-1.5 backdrop-blur-md",
            "[-webkit-font-smoothing:antialiased]",
            "transition-all duration-300 ease-out will-change-transform",
            dockExpanded
              ? "translate-y-0 opacity-100"
              : "translate-y-4 opacity-0 pointer-events-none",
          )}
        >
          <DockButton
            label="Toggle sidebar"
            active={sidebarOpen}
            onClick={toggleSidebar}
            shortcut="⌘\\"
          >
            {sidebarOpen ? <PanelLeftClose size={16} strokeWidth={2} /> : <PanelLeft size={16} strokeWidth={2} />}
          </DockButton>
          <DockSeparator />
          <ViewToggle value={viewMode} onChange={setViewMode} />
          <DockSeparator />
          <DockButton label="Search" onClick={() => setSearchPalette(true)} shortcut="⌘K">
            <Search size={16} strokeWidth={2} />
          </DockButton>
          <DockButton label="Agent" active={agentBarOpen} onClick={toggleAgentBar} shortcut="/">
            <Sparkles size={16} strokeWidth={2} />
          </DockButton>
          <DockButton label="Agent settings" onClick={() => setAgentSettings(true)} shortcut="⌘,">
            <Settings size={16} strokeWidth={2} />
          </DockButton>
          <DockSeparator />
          <DockButton label="Collapse dock" onClick={toggleDock}>
            <ChevronDown size={16} strokeWidth={2} />
          </DockButton>
        </div>
      </div>

      {/* ── Reveal pill — bottom-right, visible only when collapsed ── */}
      <button
        type="button"
        onClick={toggleDock}
        title="Expand dock"
        aria-label="Expand dock"
        inert={dockExpanded}
        className={cn(
          "shadow-glass border-forest-200 bg-sand-100/80 pointer-events-auto",
          "absolute right-4 bottom-0 flex items-center gap-1.5 rounded-full border px-3 py-2 backdrop-blur-md",
          "[-webkit-font-smoothing:antialiased]",
          "transition-all duration-300 ease-out will-change-transform",
          dockExpanded
            ? "translate-y-2 opacity-0 pointer-events-none"
            : "translate-y-0 opacity-100",
        )}
      >
        <CurrentViewIcon size={14} strokeWidth={2} className="text-forest-600" aria-hidden />
        <ChevronUp size={12} strokeWidth={2} className="text-forest-400" aria-hidden />
      </button>

    </div>
  );
}

interface DockButtonProps {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  shortcut?: string;
  onClick: () => void;
}

function DockButton({ children, label, active, shortcut, onClick }: DockButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      className={cn(
        "rounded-full px-3 py-2 text-sm transition-all duration-200 ease-out",
        // will-change pre-promotes the element to a compositor layer so
        // WKWebView (Tauri) doesn't re-rasterize SVG strokes on each hover
        // frame — prevents the 1px translate jitter visible on macOS.
        "will-change-transform hover:-translate-y-px active:translate-y-0",
        active
          ? "bg-forest-800 text-sand-100 shadow-soft"
          : "text-forest-600 hover:bg-forest-100",
      )}
    >
      {children}
    </button>
  );
}

function DockSeparator() {
  return <span aria-hidden className="bg-forest-200/60 mx-1 h-5 w-px" />;
}


interface ViewToggleProps {
  value: ViewMode;
  onChange: (m: ViewMode) => void;
}

const VIEW_MODES: { id: ViewMode; label: string; Icon: typeof Pencil }[] = [
  { id: "editor", label: "Editor", Icon: Pencil },
  { id: "tree", label: "Tree", Icon: Shrub },
  { id: "forest", label: "Forest", Icon: Trees },
];

function ViewToggle({ value, onChange }: ViewToggleProps) {
  // Deliberately NOT role="tablist": there's no addressable tabpanel
  // (the whole main pane swaps) and we don't implement the roving-
  // tabindex arrow-key contract the tabs pattern requires. A group of
  // toggle buttons with aria-pressed describes exactly what this is.
  return (
    <div role="group" aria-label="View mode" className="flex items-center gap-0.5">
      {VIEW_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          aria-pressed={value === m.id}
          title={m.label}
          onClick={() => onChange(m.id)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm transition-all duration-200 ease-out",
            "will-change-transform hover:-translate-y-px active:translate-y-0",
            value === m.id
              ? "bg-forest-800 text-sand-100 shadow-soft"
              : "text-forest-600 hover:bg-forest-100",
          )}
        >
          <m.Icon size={16} strokeWidth={2} aria-hidden />
          <span className="hidden sm:inline">{m.label}</span>
        </button>
      ))}
    </div>
  );
}
