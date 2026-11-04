import { beforeEach, describe, expect, it, vi } from "vitest";
import { satellites } from "../../src/lib/liveRecords";
import * as satellitesRoute from "../../src/pages/api/satellites";
import { ago, freezeTime } from "../clock";
import { HST, ISS } from "../fixtures/celestrak";
import { liveTable } from "../fixtures/dynamo";
import { call } from "../next";

// The visual satellites' orbits, as the AWS timetables function fetches
// them each morning.

const DAY = 86_400;

describe("/api/satellites", () => {
  let table: ReturnType<typeof liveTable>;

  beforeEach(() => {
    freezeTime();
    vi.stubEnv("LIVE_TABLE", "scene-live-test");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
    table = liveTable();
    table.seed(satellites, ago(3 * DAY), { orbits: [ISS] });
    table.seed(satellites, ago(2 * DAY), { orbits: [ISS, HST] });
  });

  it("serves the newest orbits for an hour", async () => {
    const response = await call(satellitesRoute);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=3600, stale-while-revalidate=86400"
    );
    expect(await response.json()).toEqual({
      fetched: ago(2 * DAY),
      orbits: [ISS, HST],
    });
  });

  it("serves a replay those fetched last before then, for a day", async () => {
    const response = await call(satellitesRoute, `/?at=${ago(2.5 * DAY)}`);

    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=86400"
    );
    expect(await response.json()).toEqual({
      fetched: ago(3 * DAY),
      orbits: [ISS],
    });
  });

  it("serves a replay from before the first fetch the first", async () => {
    const response = await call(satellitesRoute, `/?at=${ago(10 * DAY)}`);

    expect(await response.json()).toHaveProperty("fetched", ago(3 * DAY));
  });

  it("won't replay further back than the logs go", async () => {
    const response = await call(satellitesRoute, `/?at=${ago(31 * DAY)}`);

    expect(response.status).toBe(400);
  });

  it("is unavailable until some have been fetched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    table = liveTable();

    const response = await call(satellitesRoute);

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
  });
});
