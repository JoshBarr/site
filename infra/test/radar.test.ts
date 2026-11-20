import * as Effect from "effect/Effect";
import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { radar } from "../../src/lib/liveRecords";
import { rateOf } from "../../src/lib/radar";
import { RADAR_SIZE, rateByte } from "../../src/lib/radarGrid";
import { ago, freezeTime, NOW } from "../../test/clock";
import { encodePng } from "../../test/fixtures/png";
import { server } from "../../test/msw";
import { makeFeeds } from "../poller/feeds";
import { LiveBucket, publisher } from "../poller/positions";
import { LiveTable } from "../poller/table";
import { makeBucket } from "./bucket";
import { makeTable } from "./table";

// The poller's radar feed: RainViewer's newest frame over the map, logged
// once each, and asked for no more often than there could be a new one.

const FRAMES = "https://api.rainviewer.com/public/weather-maps.json";
const HOST = "https://tilecache.rainviewer.com";

const MINUTE = 60_000;

/** NOW is 07:00:20 UTC: the frame of 06:50 is the newest up. */
const SIX_FIFTY = Date.parse("2026-11-02T06:50:00Z");

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
const coldFeed = async () => (await Effect.runPromise(makeFeeds)).logs.radar;

describe("the poller's radar feed", () => {
  /** The frames RainViewer has, epoch ms. */
  let frames: number[];
  /** How often it's been asked what frames it has, and for which pictures. */
  let asks: number;
  let pictures: string[];
  let down: boolean;

  beforeEach(() => {
    table = makeTable();
    bucket = makeBucket();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});

    frames = [SIX_FIFTY - 10 * MINUTE, SIX_FIFTY];
    asks = 0;
    pictures = [];
    down = false;

    // 30 dBZ everywhere: 2.7 mm/h.
    const raining = encodePng(
      512,
      512,
      Uint8Array.from(
        { length: 512 * 512 * 4 },
        (_, k) => [0, 0x55, 0x88, 255][k % 4]
      ),
      { type: 6 }
    );

    server.use(
      http.get(FRAMES, () => {
        asks++;

        return down
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({
              host: HOST,
              radar: {
                past: frames.map((time) => ({
                  time: time / 1000,
                  path: `/v2/radar/${time / 1000}`,
                })),
              },
            });
      }),
      http.get(`${HOST}/v2/radar/:frame/*`, ({ params }) => {
        pictures.push(String(params.frame));

        return new HttpResponse(raining);
      })
    );
  });

  it("logs each frame once, not asking until the next is due", async () => {
    const feed = await coldFeed();

    await run(feed.poll);

    const [stored] = table.records(radar);

    expect(stored).toMatchObject({ pk: "radar", sk: NOW });
    expect(stored.data.time).toBe(SIX_FIFTY);

    const cells = Buffer.from(stored.data.cells, "base64");

    expect(cells).toHaveLength(RADAR_SIZE * RADAR_SIZE);
    expect(new Set(cells)).toEqual(new Set([rateByte(rateOf(30))]));

    // Until 07:00's due there's nothing to ask.
    freezeTime(SIX_FIFTY + 9 * MINUTE + 50_000);
    await run(feed.poll);
    expect(asks).toBe(1);

    // Due, but not up yet: asked each minute, no picture fetched.
    freezeTime(SIX_FIFTY + 11 * MINUTE);
    await run(feed.poll);
    freezeTime(SIX_FIFTY + 12 * MINUTE);
    await run(feed.poll);
    expect(asks).toBe(3);
    expect(pictures).toEqual([String(SIX_FIFTY / 1000)]);
    expect(table.records(radar)).toHaveLength(1);

    frames.push(SIX_FIFTY + 10 * MINUTE);
    freezeTime(SIX_FIFTY + 13 * MINUTE);
    await run(feed.poll);

    expect(table.records(radar).map(({ data }) => data.time)).toEqual([
      SIX_FIFTY,
      SIX_FIFTY + 10 * MINUTE,
    ]);
  });

  it("asks only every fifth minute once the frames have stopped", async () => {
    const feed = await coldFeed();

    await run(feed.poll);

    for (let minute = 31; minute <= 40; minute++) {
      freezeTime(SIX_FIFTY + minute * MINUTE);
      await run(feed.poll);
    }

    // The first time, then at 07:25 and 07:30.
    expect(asks).toBe(3);
  });

  it("goes by the newest frame stored when it starts", async () => {
    table.seed(radar, ago(120), { time: SIX_FIFTY, cells: "AAAA" }, ago(120));

    await run((await coldFeed()).poll);

    // The next was due, so it asked; the newest up is the one stored.
    expect(asks).toBe(1);
    expect(pictures).toEqual([]);
    expect(table.records(radar)).toHaveLength(1);
  });

  it("logs nothing when RainViewer's down, and asks again the next minute", async () => {
    down = true;

    const feed = await coldFeed();

    await expect(run(feed.poll)).rejects.toThrow();
    expect(table.records(radar)).toEqual([]);

    down = false;
    freezeTime(NOW + MINUTE);
    await run(feed.poll);
    expect(table.records(radar)).toHaveLength(1);
  });

  it("publishes the last half hour's scans with the positions", async () => {
    const scan = (minutes: number) => ({
      time: SIX_FIFTY - minutes * MINUTE,
      cells: "AAAA",
    });

    // Each logged five minutes after its frame; the oldest is past keeping.
    for (const minutes of [50, 20, 10, 0]) {
      const logged = SIX_FIFTY - (minutes - 5) * MINUTE;

      table.seed(radar, logged, scan(minutes), logged);
    }

    const feeds = await Effect.runPromise(makeFeeds);
    const publish = await Effect.runPromise(publisher(feeds));

    await run(feeds.logs.radar.poll);
    await run(publish.poll);

    expect(bucket.published().radar).toEqual([scan(20), scan(10), scan(0)]);
  });
});
