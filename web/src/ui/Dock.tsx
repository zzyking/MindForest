/**
 * Floating bottom dock. Holds workspace-wide affordances: sidebar
 * toggle, view-mode segmented switch (editor / tree / graph), and the
 * search palette opener. Sticks to bottom-center so it's reachable from
 * any pointer position without being modal.
 *
 * The view-mode toggle only flips the workspace's pane; the route stays
 * the same. Picking a node from tree/graph navigates back to editor by
 * default — see `useFocusNode` callers in TreeView / GraphView.
 */

import { cn } from "@/lib/cn";
import { useWorkspaceUI, type ViewMode } from "@/stores/workspaceUI";

export function Dock() {
  const sidebarOpen = useWorkspaceUI((s) => s.sidebarOpen);
  const toggleSidebar = useWorkspaceUI((s) => s.toggleSidebar);
  const setSearchPalette = useWorkspaceUI((s) => s.setSearchPalette);
  const viewMode = useWorkspaceUI((s) => s.viewMode);
  const setViewMode = useWorkspaceUI((s) => s.setViewMode);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
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
          {sidebarOpen ? "◧" : "◫"}
        </DockButton>
        <DockSeparator />
        <ViewToggle value={viewMode} onChange={setViewMode} />
        <DockSeparator />
        <DockButton
          label="Search (⌘K)"
          onClick={() => setSearchPalette(true)}
          shortcut="⌘K"
        >
          🔍
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
        "rounded-full px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-forest-800 text-sand-100"
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

const VIEW_MODES: { id: ViewMode; label: string; icon: string }[] = [
  { id: "editor", label: "Editor", icon: "✎" },
  { id: "tree", label: "Tree", icon: "⌬" },
  { id: "graph", label: "Graph", icon: "◉" },
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
            "rounded-full px-3 py-1.5 text-sm transition-colors",
            value === m.id
              ? "bg-forest-800 text-sand-100"
              : "text-forest-600 hover:bg-forest-100",
          )}
        >
          <span aria-hidden className="mr-1">
            {m.icon}
          </span>
          {m.label}
        </button>
      ))}
    </div>
  );
}
