import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GridFlow } from "../../src/lib/gridFlow";
import { grid } from "../../src/lib/liveRecords";
import * as gridRoute from "../../src/pages/api/grid";
import { ago, freezeTime } from "../clock";
import { liveTable } from "../fixtures/dynamo";
import { published } from "../fixtures/positions";
import { call } from "../next";

// /api/grid: what the grid's carrying, as the poller logged it, or as it
// last published it when the table can't be read.

const flow = (mw: number, seconds: number): GridFlow => ({
  hvdc: { time: ago(seconds + 1800), mw },
  northIsland: { time: ago(seconds), mw: 3011 },
  sites: {
    time: ago(seconds),
    load: { CPK: 119.6, HAY: 34 },
    generation: { WWD: 78.7 },
  },
});

describe("/api/grid", () => {
  beforeEach(() => freezeTime());

  it("serves what the poller published", async () => {
    published({ grid: flow(961, 120) });

    const response = await call(gridRoute);

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300"
    );

    expect(await response.json()).toEqual(flow(961, 120));
  });

  it("is unavailable until the grid's been heard from, briefly cached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    published({});

    const response = await call(gridRoute);

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=60");
    expect(await response.json()).toEqual({ error: "grid unavailable" });
  });

  it("won't replay a time that's not one", async () => {
    const response = await call(gridRoute, "/?at=yesterday");

    expect(response.status).toBe(400);
  });

  describe("from the table", () => {
    let table: ReturnType<typeof liveTable>;

    /** An hour ago: long enough for every poll up to then to be in. */
    const AT = ago(3600);

    beforeEach(() => {
      vi.stubEnv("LIVE_TABLE", "scene-live-test");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
      table = liveTable();
      table.seed(grid, ago(3900), flow(-284, 3960));
      table.seed(grid, ago(60), flow(961, 120));
    });

    it("serves the newest logged", async () => {
      expect(await (await call(gridRoute)).json()).toEqual(flow(961, 120));
    });

    it("serves what it was carrying then, with ?at=, cached for a day", async () => {
      const response = await call(gridRoute, `/?at=${AT}`);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=86400"
      );

      expect(await response.json()).toEqual(flow(-284, 3960));
    });
  });
});
