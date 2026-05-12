import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import "@/styles/globals.css";

// Window live-resize tracker.
//
// Two distinct interventions, both gated on the `resize` event:
//
// (1) `data-resizing` flag on <html>. globals.css uses it to disable
//     animations, transitions, backdrop-filter, mix-blend-mode, and the
//     noise overlay — each of which would otherwise force a full-window
//     WKWebView recomposite every frame.
//
// (2) Body-pinning on *left-edge* drags only. When the window's left
//     edge is being dragged, `screenX` changes between resize events.
//     We detect this and pin <body> to viewport-right with a fixed
//     width snapshot — the inner layout (sidebar grid, main pane,
//     CodeMirror) sees no width change at all, so no reflow happens.
//     The NSWindow's left side reveals its own backgroundColor
//     (forest-50, set in rust/apps/desktop/src/main.rs) during the
//     drag, then on release we unpin and a single reflow catches up.
//
// Right-edge drags don't move `screenX`, so they skip the pinning and
// keep the current "content reflows with lag" behaviour the user
// already finds acceptable. After 120ms with no resize events we
// restore everything in one go.
let resizeTimer = 0;
let bodyPinned = false;
let lastScreenX = window.screenX;

function pinBody() {
  if (bodyPinned) return;
  const w = document.body.getBoundingClientRect().width;
  // position:fixed anchors to the viewport regardless of html's own
  // positioning, so we don't have to mutate <html>'s styles too.
  const s = document.body.style;
  s.position = "fixed";
  s.top = "0";
  s.right = "0";
  s.height = "100vh";
  s.width = `${w}px`;
  bodyPinned = true;
}

function unpinBody() {
  if (!bodyPinned) return;
  const s = document.body.style;
  s.position = "";
  s.top = "";
  s.right = "";
  s.height = "";
  s.width = "";
  bodyPinned = false;
}

window.addEventListener("resize", () => {
  const screenX = window.screenX;
  const isLeftEdgeDrag = screenX !== lastScreenX;
  lastScreenX = screenX;

  if (isLeftEdgeDrag) {
    pinBody();
  } else if (bodyPinned) {
    // A right-edge resize tick arrived while we were still pinned
    // (e.g., user finished a left-edge drag then immediately grabbed
    // the right edge). Unpin so the right edge behaves normally.
    unpinBody();
  }

  document.documentElement.dataset.resizing = "1";
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    delete document.documentElement.dataset.resizing;
    unpinBody();
  }, 120);
});

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element missing from index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
