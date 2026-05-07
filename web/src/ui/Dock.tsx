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
          <SidebarGlyph open={sidebarOpen} />
        </DockButton>
        <DockSeparator />
        <ViewToggle value={viewMode} onChange={setViewMode} />
        <DockSeparator />
        <DockButton
          label="Search (⌘K)"
          onClick={() => setSearchPalette(true)}
          shortcut="⌘K"
        >
          <SearchGlyph />
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

/**
 * Hand-drawn-feel magnifying glass — straight stroke, no flourish, fits
 * the Unicode-glyph aesthetic of the rest of the dock without dragging
 * in a full icon-font dependency. Stroke width matches the dock's
 * border weight (1px → currentColor).
 */
function SearchGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block"
    >
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.4" y1="10.4" x2="13.5" y2="13.5" />
    </svg>
  );
}

interface ViewToggleProps {
  value: ViewMode;
  onChange: (m: ViewMode) => void;
}

const VIEW_MODES: { id: ViewMode; label: string; Icon: () => React.ReactElement }[] = [
  { id: "editor", label: "Editor", Icon: EditorGlyph },
  { id: "tree", label: "Tree", Icon: TreeGlyph },
  { id: "forest", label: "Forest", Icon: ForestGlyph },
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
          <m.Icon />
          {m.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Stroke-based glyphs sized for the dock — 14×14, currentColor, the
 * same stroke weight as the search magnifier so the dock reads as a
 * single icon set instead of an emoji-and-svg mix.
 */
function GlyphFrame({ children }: { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block flex-none"
    >
      {children}
    </svg>
  );
}

/** Editor: a feather / pen nib drawn diagonally. */
function EditorGlyph() {
  return (
    <GlyphFrame>
      <path d="M3 13 L13 3" />
      <path d="M11 1 L15 5 L13 7 L9 3 Z" />
      <path d="M3 13 L1.5 14.5 L1 13 L3 13 Z" />
    </GlyphFrame>
  );
}

/** Tree: root + two leaves. */
function TreeGlyph() {
  return (
    <GlyphFrame>
      <circle cx="8" cy="3" r="1.6" />
      <circle cx="3.5" cy="12.5" r="1.6" />
      <circle cx="12.5" cy="12.5" r="1.6" />
      <path d="M8 4.6 L8 8 M8 8 L4 11.2 M8 8 L12 11.2" />
    </GlyphFrame>
  );
}

/** Forest: a hub-and-spoke constellation — what the Forest view literally renders. */
function ForestGlyph() {
  return (
    <GlyphFrame>
      <circle cx="8" cy="8" r="1.6" />
      <circle cx="3" cy="4" r="1" />
      <circle cx="13" cy="4" r="1" />
      <circle cx="2.5" cy="11" r="1" />
      <circle cx="13.5" cy="11" r="1" />
      <path d="M8 8 L3 4 M8 8 L13 4 M8 8 L2.5 11 M8 8 L13.5 11" />
    </GlyphFrame>
  );
}

/** Sidebar toggle: panel with a left rail; the rail is filled when open. */
function SidebarGlyph({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block flex-none"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="6" y1="3" x2="6" y2="13" />
      {open && <rect x="2" y="3" width="4" height="10" rx="1.5" fill="currentColor" opacity="0.4" stroke="none" />}
    </svg>
  );
}
