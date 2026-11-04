import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Timetable } from "../../src/lib/cablecar";
import { cableCar } from "../../src/lib/liveRecords";
import * as cableCarRoute from "../../src/pages/api/cablecar";
import { freezeTime } from "../clock";
import { liveTable } from "../fixtures/dynamo";
import { call } from "../next";

// The cable car's timetable, as the AWS timetables function keeps it.

const TIMETABLE: Omit<Timetable, "etag"> = {
  start: "20261102",
  end: "20261113",
  services: { "CCL Weekday": ["20261104"] },
  trips: [
    {
      service: "CCL Weekday",
      direction: 1,
      stops: [
        ["KELB", 27000],
        ["LAMB", 27300],
      ],
    },
  ],
};

describe("/api/cablecar", () => {
  let table: ReturnType<typeof liveTable>;

  beforeEach(() => {
    freezeTime();
    vi.stubEnv("LIVE_TABLE", "scene-live-test");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
    table = liveTable();
  });

  it("serves the timetable stored, without its ETag, for an hour", async () => {
    table.seed(cableCar, "timetable", { etag: '"feed-1"', ...TIMETABLE });

    const response = await call(cableCarRoute);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=3600, stale-while-revalidate=86400"
    );
    expect(await response.json()).toEqual(TIMETABLE);
  });

  it("is unavailable until one's been stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await call(cableCarRoute);

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
  });
});
