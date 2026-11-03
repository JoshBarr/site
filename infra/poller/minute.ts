import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { Feed } from "./feeds";

// One invocation: EventBridge Scheduler's shortest rate is a minute, so each
// feed polls on its own loop until STOP, then logs what it did.

/** No poll starts later than this into an invocation, ms. */
const STOP = 52_000;

const run = (feed: Feed, start: number) =>
  Effect.gen(function* () {
    for (let at = start + feed.offset; at < start + STOP; at += feed.every) {
      const now = yield* Clock.currentTimeMillis;

      yield* Effect.sleep(Math.max(0, at - now));

      // One feed failing (Metlink down, say) doesn't stop the others.
      yield* feed.poll.pipe(
        Effect.catchCause((cause) => Effect.logError(`[${feed.name}]`, cause))
      );
    }

    yield* feed.report;
  });

/** A minute's polling, every feed at once. */
export const pollMinute = (feeds: readonly Feed[]) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;

    yield* Effect.forEach(feeds, (feed) => run(feed, start), {
      concurrency: "unbounded",
      discard: true,
    });
  });
