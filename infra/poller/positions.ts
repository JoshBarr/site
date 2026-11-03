import type * as AWS from "@alchemy.run/aws";
import type * as S3 from "@distilled.cloud/aws/s3";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { gzipSync } from "node:zlib";
import { foldBuses } from "../../src/lib/busStore";
import { HISTORY } from "../../src/lib/flights";
import { foldFlights } from "../../src/lib/flightStore";
import { positions } from "../../src/lib/positions";
import { foldTrains } from "../../src/lib/trainStore";
import { foldVessels } from "../../src/lib/vesselStore";
import type { Feed, makeFeeds } from "./feeds";

// Every live layer as its API serves it, folded from what the feeds have
// stored and published to S3, which the site reads through CloudFront until
// it can read the table itself (see plans/dynamo.md).

/** Where in the bucket (see ../live.ts) they're published. */
export const KEY = "live/positions.json";

/**
 * The bucket's operations: in Lambda, Alchemy's binding to it, which also
 * grants the function it.
 */
export class LiveBucket extends Context.Service<
  LiveBucket,
  {
    readonly putObject: (
      request: AWS.S3.PutObjectRequest
    ) => Effect.Effect<S3.PutObjectOutput, S3.PutObjectError>;
  }
>()("LiveBucket") {}

type Feeds = Effect.Success<typeof makeFeeds>;

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * Publishes the positions once a minute, 51 s in, after every feed's last
 * poll has started, when a feed's written something since. The site reads
 * the table and only falls back to these, so a minute old will do: ~44k
 * PUTs a month, where every 10 s was ~220k (about $1.20).
 */
export const publisher = ({ logs, routes }: Feeds) =>
  Effect.gen(function* () {
    const published = yield* Ref.make(-1);
    const stats = yield* Ref.make({ publishes: 0, size: 0 });

    const poll = Effect.gen(function* () {
      const counts = yield* Effect.all(
        Object.values(logs).map(({ writes }) => writes)
      );

      const writes = counts.reduce((a, b) => a + b, 0);

      if (writes === (yield* Ref.get(published))) return;

      const polls = yield* Effect.all({
        trains: logs.trains.polls,
        buses: logs.buses.polls,
        flights: logs.flights.polls,
        vessels: logs.vessels.polls,
        traffic: logs.traffic.polls,
        weather: logs.weather.polls,
      });

      const now = yield* Clock.currentTimeMillis;
      const traffic = polls.traffic.at(-1);

      const body = positions.parse({
        v: 1,
        time: now,
        trains: foldTrains(polls.trains, now),
        buses: foldBuses(polls.buses, now),
        aircraft: foldFlights(polls.flights, routes, now - HISTORY),
        vessels: foldVessels(polls.vessels, now),
        traffic: traffic ? { fetched: traffic.sk, ...traffic.data } : null,
        weather: polls.weather.at(-1)?.data ?? null,
      });

      const data = gzipSync(JSON.stringify(body));
      const bucket = yield* LiveBucket;

      yield* bucket.putObject({
        Key: KEY,
        Body: data,
        ContentType: "application/json",
        ContentEncoding: "gzip",
        // As long as CloudFront keeps it (../alchemy.run.ts).
        CacheControl: "max-age=10",
      });

      yield* Ref.set(published, writes);

      yield* Ref.update(stats, ({ publishes }) => ({
        publishes: publishes + 1,
        size: data.length,
      }));
    });

    const report = Effect.gen(function* () {
      const { publishes, size } = yield* Ref.getAndSet(stats, {
        publishes: 0,
        size: 0,
      });

      yield* Effect.log(`[positions] ${publishes} publishes of ${kb(size)}`);
    });

    return {
      name: "positions",
      every: 60_000,
      offset: 51_000,
      poll,
      report,
    } satisfies Feed;
  });
