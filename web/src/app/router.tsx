/**
 * TanStack Router setup. Code-based (no file-based codegen) so the
 * route shape lives next to the data flow that depends on it.
 *
 * URL grammar:
 *   /                          IndexPage — pick or create a topic
 *   /$topicId                  TopicPage — redirects to focused root
 *   /$topicId/$nodeId          NodePage — workspace + editor
 *
 * The route hierarchy mounts `WorkspaceShell` at the root so the
 * sidebar / dock / palette persist across navigations; only `<Outlet/>`
 * swaps when the user moves between nodes. This makes back/forward feel
 * like a browser instead of remounting half the UI on every focus
 * change.
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { WorkspaceShell } from "./WorkspaceShell";
import { getTopic } from "@/lib/api";
import { IndexPage } from "@/features/topic/IndexPage";
import { NodePage } from "@/features/topic/NodePage";

const rootRoute = createRootRoute({
  component: function Root() {
    return (
      <WorkspaceShell>
        <Outlet />
      </WorkspaceShell>
    );
  },
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexPage,
});

const topicRoute = createRoute({
  getParentRoute: () => rootRoute,
  // `$topicId` is the slug. We don't render anything for the bare
  // topic URL — the loader fetches the topic and throws a redirect to
  // its root node so the editor always has an id to focus on. If the
  // topic is missing the API throws an ApiError; the router shows its
  // default error UI (we'll style it in P4 polish).
  path: "/$topicId",
  loader: async ({ params }) => {
    const detail = await getTopic(params.topicId);
    throw redirect({
      to: "/$topicId/$nodeId",
      params: { topicId: detail.id, nodeId: detail.root_node_id },
      replace: true,
    });
  },
});

const nodeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$topicId/$nodeId",
  component: NodePage,
});

const routeTree = rootRoute.addChildren([indexRoute, topicRoute, nodeRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
