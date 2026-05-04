/**
 * Floating bottom dock. Holds workspace-wide affordances: sidebar
 * toggle, search palette opener, and a placeholder for tree/graph
 * toggles in P2. Sticks to bottom-center so it's reachable from any
 * pointer position without being modal.
 */

import { cn } from "@/lib/cn";
import { useWorkspaceUI } from "@/stores/workspaceUI";

export function Dock() {
  const sidebarOpen = useWorkspaceUI((s) => s.sidebarOpen);
  const toggleSidebar = useWorkspaceUI((s) => s.toggleSidebar);
  const setSearchPalette = useWorkspaceUI((s) => s.setSearchPalette);

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
