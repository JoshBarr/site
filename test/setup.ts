import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./msw";
import { redis } from "./redis";
import { installRequestContext } from "./vercel";

installRequestContext();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));

afterEach(() => {
  server.resetHandlers();
  redis.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => server.close());
