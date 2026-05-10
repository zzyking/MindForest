/**
 * Floating bottom dock. Holds workspace-wide affordances: sidebar
 * toggle, view-mode segmented switch (editor / tree / forest), and the
 * search palette opener. Sticks to bottom-center so it's reachable from
 * any pointer position without being modal.
 *
 * The view-mode toggle only flips the workspace's pane; the route stays
 * the same. Picking a node from tree/forest navigates back to editor by
 * default — see `useFocusNode` callers in TreeView / ForestView.
 *
 * Collapse behaviour: both this dock and the AgentPromptBar slide out
 * via `dockExpanded` in workspaceUI. A small reveal pill at the
 * bottom-right lets the user bring them back.
 */

import { ChevronDown, ChevronUp, PanelLeft, PanelLeftClose, Pencil, Search, Settings, Shrub, Trees } from "lucide-react";

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
  const isLg = useMediaQuery("(min-width: 1024px)");

  const CurrentViewIcon = VIEW_MODES.find((m) => m.id === viewMode)?.Icon ?? Pencil;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4">

      {/* ── Main dock pill — centred over the main pane ── */}
      <div
        className={cn(
          "flex justify-center",
          "transition-[padding] duration-300 ease-out",
          // Below lg (≈sidebar+agent bar) centre over full viewport; above it
          // shift right so the dock tracks the main content area.
          sidebarOpen && isLg ? "pl-72" : "",
        )}
      >
        <div
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
          <DockButton label="Search (⌘K)" onClick={() => setSearchPalette(true)} shortcut="⌘K">
            <Search size={16} strokeWidth={2} />
          </DockButton>
          <DockButton label="Agent settings (⌘,)" onClick={() => setAgentSettings(true)} shortcut="⌘,">
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
        className={cn(
          "shadow-glass border-forest-200 bg-sand-100/80 pointer-events-auto",
          "absolute right-4 bottom-0 flex items-center gap-1.5 rounded-full border px-3 py-1.5 backdrop-blur-md",
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
        "rounded-full px-3 py-1.5 text-sm transition-all duration-200 ease-out",
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
  return (
    <div role="tablist" aria-label="View mode" className="flex items-center gap-0.5">
      {VIEW_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="tab"
          aria-selected={value === m.id}
          title={m.label}
          onClick={() => onChange(m.id)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-all duration-200 ease-out",
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
