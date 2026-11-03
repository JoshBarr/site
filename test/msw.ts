import { passthrough } from "msw";
import { http } from "msw/http";
import { setupServer } from "msw/node";

/**
 * The network as the API routes see it in tests: whatever each test adds
 * with `server.use()`. Anything else fails the request.
 */
export const server = setupServer(
  // The routes under test, served locally by ./next.ts.
  http.all(
    ({ request }) => new URL(request.url).hostname === "127.0.0.1",
    () => passthrough()
  )
);
