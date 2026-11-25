import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlockSummary } from "../../src/lib/flocks";
import { flocks } from "../../src/lib/liveRecords";
import * as birdsRoute from "../../src/pages/api/birds";
import { ago, freezeTime } from "../clock";
import { liveTable, tableDenied } from "../fixtures/dynamo";
import { call } from "../next";

// Where the flocks gather, as the AWS timetables function sums up birders'
// checklists every three hours.

const HOUR = 3_600;
const DAY = 24 * HOUR;

const GULLS: FlockSummary = {
  sites: [
    {
      kind: "gull",
      species: ["kelgul"],
      position: [1747100, 5421304],
      radius: 191,
      size: 110,
      peak: 110,
      weight: 0.78,
      seen: 1,
      last: ago(2 * DAY),
    },
  ],
  species: {
    kelgul: { name: "Kelp Gull", sci: "Larus dominicanus", kind: "gull" },
  },
};

const MORE_GULLS: FlockSummary = {
  ...GULLS,
  sites: [{ ...GULLS.sites[0], size: 150, peak: 190, seen: 2 }],
};

describe("/api/birds", () => {
  let table: ReturnType<typeof liveTable>;

  beforeEach(() => {
    freezeTime();
    vi.stubEnv("LIVE_TABLE", "scene-live-test");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
    table = liveTable();
    table.seed(flocks, ago(6 * HOUR), GULLS);
    table.seed(flocks, ago(3 * HOUR), MORE_GULLS);
  });

  it("serves the newest summary for an hour", async () => {
    const response = await call(birdsRoute);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=3600, stale-while-revalidate=86400"
    );
    expect(await response.json()).toEqual({
      summarised: ago(3 * HOUR),
      ...MORE_GULLS,
    });
  });

  it("serves a replay the summary last made before then, for a day", async () => {
    const response = await call(birdsRoute, `/?at=${ago(4 * HOUR)}`);

    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=86400"
    );
    expect(await response.json()).toEqual({
      summarised: ago(6 * HOUR),
      ...GULLS,
    });
  });

  it("serves a replay from before the first summary no flocks", async () => {
    const response = await call(birdsRoute, `/?at=${ago(10 * DAY)}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summarised: null,
      sites: [],
      species: {},
    });
  });

  it("won't replay further back than the checklists go", async () => {
    const response = await call(birdsRoute, `/?at=${ago(31 * DAY)}`);

    expect(response.status).toBe(400);
  });

  it("is unavailable until the flocks have been summed up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    table = liveTable();

    const response = await call(birdsRoute);

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
  });

  it("is unavailable, briefly, when the table can't be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    tableDenied();

    const response = await call(birdsRoute);

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
  });
});
