import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VenueEvent } from "../../src/lib/events";
import { events } from "../../src/lib/liveRecords";
import * as eventsRoute from "../../src/pages/api/events";
import { ago, NOW } from "../clock";
import { freezeTime } from "../clock";
import { liveTable } from "../fixtures/dynamo";
import { call } from "../next";

// What's on at the big venues, as the AWS timetables function fetches it
// each morning.

const DAY = 86_400;

const GIG: VenueEvent = {
  venue: "michaelFowler",
  name: "Aldous Harding",
  kind: "music",
  start: NOW,
  end: NOW + 3 * 3_600_000,
  guessedEnd: true,
};

const MATCH: VenueEvent = {
  venue: "stadium",
  name: "Wellington Phoenix vs Adelaide United",
  kind: "football",
  start: NOW + DAY * 1000,
  end: NOW + DAY * 1000 + 2 * 3_600_000,
  guessedEnd: true,
};

describe("/api/events", () => {
  let table: ReturnType<typeof liveTable>;

  beforeEach(() => {
    freezeTime();
    vi.stubEnv("LIVE_TABLE", "scene-live-test");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
    table = liveTable();
    table.seed(events, ago(3 * DAY), { events: [GIG] });
    table.seed(events, ago(2 * DAY), { events: [GIG, MATCH] });
  });

  it("serves the newest listings for an hour", async () => {
    const response = await call(eventsRoute);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=3600, stale-while-revalidate=86400"
    );
    expect(await response.json()).toEqual({
      fetched: ago(2 * DAY),
      events: [GIG, MATCH],
    });
  });

  it("serves a replay those fetched last before then, for a day", async () => {
    const response = await call(eventsRoute, `/?at=${ago(2.5 * DAY)}`);

    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=86400"
    );
    expect(await response.json()).toEqual({
      fetched: ago(3 * DAY),
      events: [GIG],
    });
  });

  it("serves a replay from before the first fetch nothing", async () => {
    const response = await call(eventsRoute, `/?at=${ago(10 * DAY)}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fetched: null, events: [] });
  });

  it("won't replay further back than the logs go", async () => {
    const response = await call(eventsRoute, `/?at=${ago(31 * DAY)}`);

    expect(response.status).toBe(400);
  });

  it("is unavailable until some have been fetched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    table = liveTable();

    const response = await call(eventsRoute);

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
  });
});
