import { createServer } from "node:http";
import type { NextApiHandler, PageConfig } from "next";
import { apiResolver } from "next/dist/server/api-utils/node/api-resolver";
import { z } from "zod";

// API routes run as Next runs them, on a local port: query parsing, body
// parsing (or not, as a route's config says), and `res.status().json()` are
// Next's own.

interface Route {
  default: NextApiHandler;
  config?: PageConfig;
}

const address = z.object({ port: z.number() });

/** Serves `route` for one request, made with `init` to `path`. */
export async function call(route: Route, path = "/", init?: RequestInit) {
  const server = createServer((req, res) => {
    const { searchParams } = new URL(req.url ?? "/", "http://127.0.0.1");

    void apiResolver(
      req,
      res,
      Object.fromEntries(searchParams),
      route,
      {
        previewModeId: "test",
        previewModeEncryptionKey: "test",
        previewModeSigningKey: "test",
        dev: false,
      },
      false
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = address.parse(server.address());

    return await fetch(`http://127.0.0.1:${port}${path}`, init);
  } finally {
    server.close();
  }
}
