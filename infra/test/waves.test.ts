import * as Effect from "effect/Effect";
import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { waves } from "../../src/lib/liveRecords";
import { ago, freezeTime, NOW } from "../../test/clock";
import { buoy, SOUTH, tideLevels } from "../../test/fixtures/waveBuoy";
import { server } from "../../test/msw";
import { makeFeeds } from "../poller/feeds";
import { LiveBucket } from "../poller/positions";
import { LiveTable } from "../poller/table";
import { makeBucket } from "./bucket";
import { makeTable } from "./table";

// The poller's wave buoy feed: asked after every ten minutes, each half
// hour's reading logged once.

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
const coldFeed = async () => (await Effect.runPromise(makeFeeds)).logs.waves;

describe("the poller's wave buoy", () => {
  /** When the buoy's newest reading was taken, seconds ago. */
  let taken: number;
  let asked: string[];

  beforeEach(() => {
    table = makeTable();
    bucket = makeBucket();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});

    taken = 20 * 60;
    asked = tideLevels(() => [buoy(SOUTH, [[ago(taken), 1.38, 11, 202.1]])]);
  });

  it("logs each half hour's reading once, asking every ten minutes", async () => {
    const feed = await coldFeed();

    await run(feed.poll);

    expect(table.records(waves)).toMatchObject([
      {
        pk: "waves",
        sk: NOW,
        data: { time: ago(20 * 60), height: 1.38, period: 11, direction: 202 },
      },
    ]);

    freezeTime(NOW + 9 * 60_000);
    await run(feed.poll);
    expect(asked).toHaveLength(1);

    // Asked again, but the buoy's sent nothing since.
    freezeTime(NOW + 10 * 60_000);
    await run(feed.poll);
    expect(asked).toHaveLength(2);
    expect(table.records(waves)).toHaveLength(1);

    // Nor asked the minute after, though nothing was stored.
    freezeTime(NOW + 11 * 60_000);
    await run(feed.poll);
    expect(asked).toHaveLength(2);

    // The next half hour's in.
    taken = -10 * 60;
    freezeTime(NOW + 20 * 60_000);
    await run(feed.poll);
    expect(table.records(waves)).toHaveLength(2);
    expect(table.records(waves)[1].data.time).toBe(ago(-10 * 60));
  });

  it("logs nothing when the buoy's not been heard from", async () => {
    taken = 3 * 3600;

    await run((await coldFeed()).poll);

    expect(table.records(waves)).toEqual([]);
  });

  it("logs nothing when Hilltop fails, and asks again the next minute", async () => {
    server.use(
      http.get(
        "https://hilltop.gw.govt.nz/data.hts",
        () => new HttpResponse(null, { status: 503 }),
        { once: true }
      )
    );

    const feed = await coldFeed();

    await expect(run(feed.poll)).rejects.toMatchObject({
      cause: { message: "hilltop: HTTP 503" },
    });

    expect(table.records(waves)).toEqual([]);

    freezeTime(NOW + 60_000);
    await run(feed.poll);
    expect(table.records(waves)).toHaveLength(1);
  });
});
