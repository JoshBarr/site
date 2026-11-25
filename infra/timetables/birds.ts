import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  counted,
  fetchBirds,
  listChecklists,
  seenIn,
} from "../../src/lib/birds";
import { summarise } from "../../src/lib/flocks";
import { birds, flocks } from "../../src/lib/liveRecords";
import { all, put } from "../poller/table";

// Birders' checklists from eBird, every few hours: the region's newest, less
// those already stored, into an item of their own. Then the month's summed
// up into where the flocks gather, which is what the site serves: written
// each run, new checklists or not, as older sightings count for less.

const DAY = 24 * 3600_000;

/**
 * Items read back this far: the month the flocks are summed up from, and
 * more than the week or so eBird lists, for what's been read.
 */
const LOOKBACK = 30 * DAY;

/**
 * The most checklists read a run: ~30 s of the minute the function has.
 * A backlog's read over the next runs.
 */
const PER_RUN = 60;

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

export const updateBirds = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const stored = (yield* all(birds, now - LOOKBACK)).map((r) => r.data);
  const listed = yield* Effect.tryPromise(() => listChecklists());

  const found = yield* Effect.tryPromise(() =>
    fetchBirds(listed, seenIn(stored), { limit: PER_RUN })
  );

  if (found) {
    const size = yield* put(birds, now, found, now);

    stored.push(found);

    yield* Effect.log(
      `[birds] ${found.checklists.length} checklists (${found.checked.length} read), ${counted(found)} birds, ${kb(size)}`
    );
  } else {
    yield* Effect.log("[birds] nothing new");
  }

  const summary = summarise(stored, now);
  const size = yield* put(flocks, now, summary, now);

  yield* Effect.log(`[flocks] ${summary.sites.length} sites, ${kb(size)}`);
});
