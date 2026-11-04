import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { satellites } from "../../src/lib/liveRecords";
import { fetchOrbits } from "../../src/lib/satellites";
import { put } from "../poller/table";

// The visual satellites' orbits, fetched from CelesTrak once a day into the
// live table, a new item each time: a replay of a day runs them on from
// that day's.

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

export const updateSatellites = Effect.gen(function* () {
  const orbits = yield* Effect.tryPromise(fetchOrbits);
  const now = yield* Clock.currentTimeMillis;
  const size = yield* put(satellites, now, { orbits }, now);

  yield* Effect.log(`[satellites] ${orbits.length} orbits, ${kb(size)}`);
});
