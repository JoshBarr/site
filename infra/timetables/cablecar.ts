import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { fetchTimetable } from "../../src/lib/cablecar";
import { cableCar } from "../../src/lib/liveRecords";
import { newest, put } from "../poller/table";

// The cable car's timetable, kept as one item in the live table: Metlink's
// GTFS feed is asked whether it's changed since the one stored (its ETag),
// and when it has, the timetable's read out of it and written over the top.

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

export const updateCableCar = Effect.gen(function* () {
  const stored = yield* newest(cableCar);

  const fetched = yield* Effect.tryPromise(() =>
    fetchTimetable(stored?.data.etag)
  );

  if (!fetched) {
    yield* Effect.log(`[cablecar] unchanged since ${stored?.data.etag}`);

    return;
  }

  const now = yield* Clock.currentTimeMillis;
  const size = yield* put(cableCar, "timetable", fetched, now);

  yield* Effect.log(
    `[cablecar] ${fetched.trips.length} trips, ` +
      `${fetched.start} to ${fetched.end}, ${kb(size)}`
  );
});
