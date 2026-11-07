import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { timeline } from "../../src/lib/liveRecords";
import { addSample, hourOf, sample } from "../../src/lib/timeline";
import type { Feed, makeFeeds } from "./feeds";
import { newest, put } from "./table";

// The time-travel timeline's numbers (see src/lib/timeline.ts): once a
// minute, what the feeds' newest polls say is out, added to the hour's
// item. The hour's read back from the table each time rather than kept in
// memory, so a second container running alongside (a late schedule) adds
// to it rather than writing over what the other added: half an RCU a
// minute.

type Feeds = Effect.Success<typeof makeFeeds>;

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/** Counts once a minute, 50 s in, after the last of each feed's polls. */
export const counter = ({ logs }: Feeds) =>
  Effect.gen(function* () {
    const stats = yield* Ref.make({ writes: 0, size: 0 });

    const poll = Effect.gen(function* () {
      const polls = yield* Effect.all({
        trains: logs.trains.polls,
        buses: logs.buses.polls,
        flights: logs.flights.polls,
        vessels: logs.vessels.polls,
        traffic: logs.traffic.polls,
        weather: logs.weather.polls,
        metar: logs.metar.polls,
        tide: logs.tide.polls,
        quakes: logs.quakes.polls,
      });

      const now = yield* Clock.currentTimeMillis;
      const start = hourOf(now);
      const stored = yield* newest(timeline);

      const taken = sample(
        {
          trains: polls.trains.at(-1),
          buses: polls.buses.at(-1),
          flights: polls.flights.at(-1),
          vessels: polls.vessels.at(-1),
          traffic: polls.traffic.at(-1),
          weather: polls.weather.at(-1),
          metar: polls.metar.at(-1),
          tide: polls.tide.at(-1),
        },
        now
      );

      const hour = addSample(
        stored?.sk === start ? stored.data : null,
        now,
        taken,
        polls.quakes.at(-1)?.data.quakes
      );

      const size = yield* put(timeline, start, hour, now);

      yield* Ref.update(stats, ({ writes }) => ({ writes: writes + 1, size }));
    });

    const report = Effect.gen(function* () {
      const { writes, size } = yield* Ref.getAndSet(stats, {
        writes: 0,
        size: 0,
      });

      yield* Effect.log(`[timeline] ${writes} writes of ${kb(size)}`);
    });

    return {
      name: "timeline",
      every: 60_000,
      offset: 50_000,
      poll,
      report,
    } satisfies Feed;
  });
