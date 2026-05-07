/**
 * Floating bottom dock. Holds workspace-wide affordances: sidebar
 * toggle, view-mode segmented switch (editor / tree / forest), and the
 * search palette opener. Sticks to bottom-center so it's reachable from
 * any pointer position without being modal.
 *
 * The view-mode toggle only flips the workspace's pane; the route stays
 * the same. Picking a node from tree/forest navigates back to editor by
 * default — see `useFocusNode` callers in TreeView / ForestView.
 */

import { Shrub, PanelLeft, PanelLeftClose, Pencil, Search, Trees } from "lucide-react";

import { cn } from "@/lib/cn";
import { useWorkspaceUI, type ViewMode } from "@/stores/workspaceUI";

export function Dock() {
  const sidebarOpen = useWorkspaceUI((s) => s.sidebarOpen);
  const toggleSidebar = useWorkspaceUI((s) => s.toggleSidebar);
  const setSearchPalette = useWorkspaceUI((s) => s.setSearchPalette);
  const viewMode = useWorkspaceUI((s) => s.viewMode);
  const setViewMode = useWorkspaceUI((s) => s.setViewMode);

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-4 flex justify-center",
        // Centre over the main pane, not the full window — shifts
        // right when the sidebar is open so the dock visually belongs
        // to the work area, not the chrome.
        "transition-[padding] duration-300 ease-out",
        sidebarOpen ? "pl-72" : "pl-0",
      )}
    >
      <div
        className={cn(
          "shadow-glass border-forest-200 bg-sand-100/80 pointer-events-auto",
          "flex items-center gap-1 rounded-full border px-2 py-1.5 backdrop-blur-md",
        )}
      >
        <DockButton
          label="Toggle sidebar"
          active={sidebarOpen}
          onClick={toggleSidebar}
          shortcut="⌘\\"
        >
          {sidebarOpen ? <PanelLeftClose size={16} strokeWidth={1.75} /> : <PanelLeft size={16} strokeWidth={1.75} />}
        </DockButton>
        <DockSeparator />
        <ViewToggle value={viewMode} onChange={setViewMode} />
        <DockSeparator />
        <DockButton
          label="Search (⌘K)"
          onClick={() => setSearchPalette(true)}
          shortcut="⌘K"
        >
          <Search size={16} strokeWidth={1.75} />
        </DockButton>
      </div>
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
        // Subtle hover-lift — drops back on press so the affordance feels
        // physical without bouncing the whole dock.
        "hover:-translate-y-px active:translate-y-0",
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
            "hover:-translate-y-px active:translate-y-0",
            value === m.id
              ? "bg-forest-800 text-sand-100 shadow-soft"
              : "text-forest-600 hover:bg-forest-100",
          )}
        >
          <m.Icon size={16} strokeWidth={1.75} aria-hidden />
          {m.label}
        </button>
      ))}
    </div>
  );
}

