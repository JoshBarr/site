import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { grid } from "../../src/lib/liveRecords";
import { ago, freezeTime, NOW } from "../../test/clock";
import {
  dispatchAnswer,
  dispatched,
  gridDown,
  hvdcAnswer,
  loadAnswer,
} from "../../test/fixtures/transpower";
import { makeFeeds } from "../poller/feeds";
import { LiveBucket } from "../poller/positions";
import { LiveTable } from "../poller/table";
import { makeBucket } from "./bucket";
import { makeTable } from "./table";

// The poller's grid feed: what the national grid's carrying around
// Wellington, logged when any of it is newer.

/** NOW (2026-11-02T07:00:20Z) is 8:00 pm in NZ. */
const EIGHT = Date.parse("2026-11-02T07:00:00Z");

let table: ReturnType<typeof makeTable>;
let bucket: ReturnType<typeof makeBucket>;

const run = <A, E>(effect: Effect.Effect<A, E, LiveTable | LiveBucket>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(LiveTable, table.service),
      Effect.provideService(LiveBucket, bucket.service)
    )
  );

/** The feed as a newly started container has it. */
const coldFeed = async () => (await Effect.runPromise(makeFeeds)).logs.grid;

describe("the poller's grid feed", () => {
  beforeEach(() => {
    table = makeTable();
    bucket = makeBucket();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("logs the link's transfer and the island's load, every five minutes", async () => {
    hvdcAnswer(ago(1220), [941, 961]);
    loadAnswer("2026-11-02 20:00", 3011);

    const feed = await coldFeed();

    await run(feed.poll);

    expect(table.records(grid)).toEqual([
      {
        pk: "grid",
        sk: NOW,
        v: 1,
        data: {
          hvdc: { time: ago(1220), mw: 961 },
          northIsland: { time: EIGHT, mw: 3011 },
          sites: null,
        },
        expires: Math.floor(NOW / 1000) + 30 * 24 * 3600,
      },
    ]);

    // Not asked again for five minutes.
    gridDown();
    freezeTime(NOW + 4 * 60_000);
    await run(feed.poll);
    expect(table.records(grid)).toHaveLength(1);

    loadAnswer("2026-11-02 20:05", 2987);
    freezeTime(NOW + 5 * 60_000);
    await run(feed.poll);

    // The link's couldn't be fetched: it's as it was.
    expect(table.records(grid)[1].data).toEqual({
      hvdc: { time: ago(1220), mw: 961 },
      northIsland: { time: EIGHT + 300_000, mw: 2987 },
      sites: null,
    });
  });

  it("logs each substation's load too, with a key for them", async () => {
    vi.stubEnv("LIVE_EMI_KEY", "secret");
    hvdcAnswer(ago(1220), [961]);
    loadAnswer("2026-11-02 20:00", 3011);

    const asked = dispatchAnswer("secret", [
      dispatched("CPK0111", ago(90), 21.3),
      dispatched("CPK0331", ago(90), 98.3),
      dispatched("WWD1102", ago(90), 0, 40.1),
    ]);

    await run((await coldFeed()).poll);

    expect(table.records(grid)[0].data.sites).toEqual({
      time: ago(90),
      load: { CPK: 119.6, WWD: 0 },
      generation: { CPK: 0, WWD: 40.1 },
    });

    expect(asked).toEqual(["secret"]);
  });

  it("writes nothing when none of it's newer, and asks again the next minute", async () => {
    table.seed(
      grid,
      ago(300),
      {
        hvdc: { time: ago(1220), mw: 961 },
        northIsland: { time: EIGHT, mw: 3011 },
        sites: null,
      },
      ago(300)
    );

    hvdcAnswer(ago(1220), [961]);
    loadAnswer("2026-11-02 20:00", 3011);

    const feed = await coldFeed();

    await run(feed.poll);
    expect(table.records(grid)).toHaveLength(1);

    loadAnswer("2026-11-02 20:05", 2987);
    freezeTime(NOW + 60_000);
    await run(feed.poll);
    expect(table.records(grid)).toHaveLength(2);
  });

  it("fails when Transpower can't be reached", async () => {
    gridDown();

    await expect(run((await coldFeed()).poll)).rejects.toThrow();
    expect(table.records(grid)).toEqual([]);
  });
});
