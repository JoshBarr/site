import * as Effect from "effect/Effect";
import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signs } from "../../src/lib/liveRecords";
import { ago, freezeTime, NOW } from "../../test/clock";
import { SIGNS_URL, vms } from "../../test/fixtures/nztaSigns";
import { server } from "../../test/msw";
import { makeFeeds } from "../poller/feeds";
import { KEY, LiveBucket, publisher } from "../poller/positions";
import { LiveTable } from "../poller/table";
import { makeBucket } from "./bucket";
import { makeTable } from "./table";

// The poller's feed of NZTA's message signs: asked every two minutes,
// written when a message has changed, and every ten minutes regardless.

let table: ReturnType<typeof makeTable>;
let bucket: ReturnType<typeof makeBucket>;

const run = <A, E>(effect: Effect.Effect<A, E, LiveTable | LiveBucket>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(LiveTable, table.service),
      Effect.provideService(LiveBucket, bucket.service)
    )
  );

const MINUTE = 60_000;

/** NZTA's Whitby sign showing `message`: how many times it's been asked. */
function whitby(message: () => string) {
  const asked = { count: 0 };

  server.use(
    http.get(SIGNS_URL, () => {
      asked.count++;

      return HttpResponse.json({
        response: { vms: [{ ...vms[0], currentMessage: message() }] },
      });
    })
  );

  return asked;
}

const written = () =>
  table.records(signs).map(({ sk, data }) => ({ sk, data }));

describe("the poller's message signs", () => {
  beforeEach(() => {
    table = makeTable();
    bucket = makeBucket();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("are written when a message changes, asked every two minutes", async () => {
    let message = "J'VILLE [jl4]12[nl]WGTN CBD [jl4]19";
    const asked = whitby(() => message);
    const feed = (await Effect.runPromise(makeFeeds)).logs.signs;

    await run(feed.poll);

    // A minute on it's not asked; two on, it's the same.
    freezeTime(NOW + MINUTE);
    await run(feed.poll);
    freezeTime(NOW + 2 * MINUTE);
    await run(feed.poll);

    expect(asked.count).toBe(2);
    expect(written()).toEqual([
      { sk: NOW, data: { messages: { 385: message } } },
    ]);

    message = "J'VILLE [jl4]14[nl]WGTN CBD [jl4]22";
    freezeTime(NOW + 4 * MINUTE);
    await run(feed.poll);

    expect(written()).toEqual([
      {
        sk: NOW,
        data: { messages: { 385: "J'VILLE [jl4]12[nl]WGTN CBD [jl4]19" } },
      },
      { sk: NOW + 4 * MINUTE, data: { messages: { 385: message } } },
    ]);
  });

  it("are written again after ten minutes unchanged, to be known fresh", async () => {
    whitby(() => "");
    table.seed(signs, ago(601), { messages: { 385: "" } }, ago(601));

    await run((await Effect.runPromise(makeFeeds)).logs.signs.poll);

    expect(written().map(({ sk }) => sk)).toEqual([ago(601), NOW]);
  });

  it("aren't asked by a cold container within two minutes of the last write", async () => {
    const asked = whitby(() => "CRASH AHEAD");

    table.seed(signs, ago(90), { messages: { 385: "" } }, ago(90));

    await run((await Effect.runPromise(makeFeeds)).logs.signs.poll);

    expect(asked.count).toBe(0);
    expect(written().map(({ sk }) => sk)).toEqual([ago(90)]);
  });

  it("keep what was written when NZTA fails, and aren't asked again for two minutes", async () => {
    let asked = 0;

    table.seed(signs, ago(300), { messages: { 385: "ROADWORKS" } }, ago(300));
    server.use(
      http.get(SIGNS_URL, () => {
        asked++;

        return new HttpResponse(null, { status: 504 });
      })
    );

    const feed = (await Effect.runPromise(makeFeeds)).logs.signs;

    await expect(run(feed.poll)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("nzta signs: 504") },
    });

    freezeTime(NOW + MINUTE);
    await run(feed.poll);

    expect(asked).toBe(1);
    expect(written()).toEqual([
      { sk: ago(300), data: { messages: { 385: "ROADWORKS" } } },
    ]);
  });

  it("are published with when they were fetched", async () => {
    whitby(() => "J'VILLE [jl4]12");

    const made = await Effect.runPromise(makeFeeds);
    const publish = await Effect.runPromise(publisher(made));

    await run(made.logs.signs.poll);
    await run(publish.poll);

    expect(bucket.puts[0]).toMatchObject({ Key: KEY });
    expect(bucket.published()).toMatchObject({
      signs: { fetched: NOW, messages: { 385: "J'VILLE [jl4]12" } },
    });
  });
});
