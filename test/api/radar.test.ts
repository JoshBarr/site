import { beforeEach, describe, expect, it, vi } from "vitest";
import { radar } from "../../src/lib/liveRecords";
import * as radarRoute from "../../src/pages/api/radar";
import { ago, freezeTime } from "../clock";
import { liveTable, tableDenied } from "../fixtures/dynamo";
import { positionsAnswer, published } from "../fixtures/positions";
import { call } from "../next";
import { HttpResponse } from "msw/http";

// /api/radar: the rain radar's scans from the last half hour, from the
// poller's log in the table, or what it last published.

const MINUTE = 60;

/** A scan from `minutes` ago. */
const scan = (minutes: number) => ({
  time: ago(minutes * MINUTE),
  cells: `scan${minutes}`,
});

describe("/api/radar", () => {
  beforeEach(() => freezeTime());

  describe("from the table", () => {
    let table: ReturnType<typeof liveTable>;

    beforeEach(() => {
      vi.stubEnv("LIVE_TABLE", "scene-live-test");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
      table = liveTable();
    });

    /** Logs each scan five minutes after its frame, as the poller does. */
    const logged = (...minutes: number[]) => {
      for (const m of minutes) {
        table.seed(radar, ago((m - 5) * MINUTE), scan(m));
      }
    };

    it("serves the last half hour's scans, oldest first", async () => {
      logged(66, 36, 26, 16, 6);

      const response = await call(radarRoute);

      expect(response.status).toBe(200);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=60, stale-while-revalidate=300"
      );

      expect(await response.json()).toEqual({
        scans: [scan(36), scan(26), scan(16), scan(6)],
      });
    });

    it("serves a frame two containers logged once", async () => {
      logged(16, 6);
      table.seed(radar, ago(30), scan(6));

      expect(await (await call(radarRoute)).json()).toEqual({
        scans: [scan(16), scan(6)],
      });
    });

    it("serves none when the radar's not been read for a while", async () => {
      logged(90, 80);

      const response = await call(radarRoute);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ scans: [] });
    });

    it("serves the scans as they were at a moment replayed, cached for a day", async () => {
      logged(96, 86, 76, 66, 16, 6);

      const response = await call(radarRoute, `/?at=${ago(62 * MINUTE)}`);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=86400"
      );

      // 66's frame was up by then, but the poller hadn't logged it.
      expect(await response.json()).toEqual({
        scans: [scan(96), scan(86), scan(76)],
      });
    });

    it("falls back on what's published when the table can't be read", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      tableDenied();
      published({ radar: [scan(16), scan(6)] });

      expect(await (await call(radarRoute)).json()).toEqual({
        scans: [scan(16), scan(6)],
      });
    });
  });

  it("serves what's published without a table", async () => {
    published({ radar: [scan(6), scan(16), scan(70)] });

    expect(await (await call(radarRoute)).json()).toEqual({
      scans: [scan(16), scan(6)],
    });
  });

  it("serves none from positions published before the radar was read", async () => {
    published({});

    expect(await (await call(radarRoute)).json()).toEqual({ scans: [] });
  });

  it("won't replay a time that's not one", async () => {
    const response = await call(radarRoute, "/?at=yesterday");

    expect(response.status).toBe(400);
  });

  it("is a 502 when nothing can be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    positionsAnswer(() => new HttpResponse(null, { status: 500 }));

    const response = await call(radarRoute);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "radar unavailable" });
  });
});
