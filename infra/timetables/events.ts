import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { fetchEvents } from "../../src/lib/events";
import { events } from "../../src/lib/liveRecords";
import { put } from "../poller/table";

// What's on at the big venues, fetched once a day into the live table, a
// new item each time: a replay lights them as they were listed that day.

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

export const updateEvents = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const found = yield* Effect.tryPromise(() => fetchEvents(now));
  const size = yield* put(events, now, { events: found }, now);

  yield* Effect.log(`[events] ${found.length} sessions, ${kb(size)}`);
});
