/**
 * App entry — mounts the TanStack Router and lets routes drive the rest.
 * All persistent layout (sidebar, dock, palette) lives in
 * `WorkspaceShell` at the route root; this component does no rendering
 * of its own.
 */

import { RouterProvider } from "@tanstack/react-router";

import { router } from "./router";

export function App() {
  return <RouterProvider router={router} />;
}
