import { beforeEach, describe, expect, it, vi } from "vitest";
import { waves } from "../../src/lib/liveRecords";
import type { Waves } from "../../src/lib/waves";
import * as wavesRoute from "../../src/pages/api/waves";
import { ago, freezeTime } from "../clock";
import { liveTable } from "../fixtures/dynamo";
import { published } from "../fixtures/positions";
import { call } from "../next";

// /api/waves: the wave buoy's newest reading, from what the AWS poller
// published or, with a table to read, from its log.

const reading = (seconds: number, height = 1.38): Waves => ({
  time: ago(seconds),
  height,
  period: 10.4,
  direction: 189,
});

describe("/api/waves", () => {
  beforeEach(() => freezeTime());

  describe("from what's published", () => {
    it("serves the buoy's reading", async () => {
      published({ waves: reading(1200) });

      const response = await call(wavesRoute);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=300, stale-while-revalidate=600"
      );

      expect(await response.json()).toEqual(reading(1200));
    });

    it("fails, for a minute, before the buoy's been heard from", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      published({});

      const response = await call(wavesRoute);

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("public, s-maxage=60");
      expect(await response.json()).toEqual({ error: "waves unavailable" });
    });

    it("serves what was published before there were waves in it as none", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      published({ waves: undefined });

      expect((await call(wavesRoute)).status).toBe(502);
    });
  });

  describe("from the table", () => {
    let table: ReturnType<typeof liveTable>;

    beforeEach(() => {
      vi.stubEnv("LIVE_TABLE", "scene-live-test");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
      table = liveTable();
    });

    it("serves the newest reading logged", async () => {
      table.seed(waves, ago(3000), reading(4200, 2.2));
      table.seed(waves, ago(1100), reading(2400));

      expect(await (await call(wavesRoute)).json()).toEqual(reading(2400));
    });

    it("serves the reading of then with ?at=", async () => {
      const at = ago(3600);

      table.seed(waves, ago(4800), reading(6000, 2.2));
      table.seed(waves, ago(3000), reading(4200));

      const response = await call(wavesRoute, `/?at=${at}`);

      expect(await response.json()).toEqual(reading(6000, 2.2));
    });

    it("won't replay a time that isn't one", async () => {
      const response = await call(wavesRoute, "/?at=yesterday");

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "can't replay that time",
      });
    });
  });
});
