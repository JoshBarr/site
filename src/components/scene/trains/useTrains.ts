import { useEffect, useState } from "react";
import { layerUrl, sceneNow, type Seek, skewFrom, useSeek } from "../clock";
import { sceneShown } from "../visibility";
import { isStale } from "../../../lib/trains";
import type { Train, TrainsResponse } from "../../../lib/trains";
import { arrive } from "../time/jump";

export type { Train };

const NONE: Train[] = [];

/** As often as /api/trains refreshes. */
const POLL = 10_000;

/**
 * Trains on the network and their trails, polled from /api/trains, which
 * answers with everything it knows each time. A failed poll keeps the last
 * answer. Times are on the scene's clock (../clock.ts); setting it starts
 * over from then.
 */
export function useTrains() {
  const seek = useSeek();

  const [shown, setShown] = useState<{ seek: Seek; trains: Train[] }>({
    seek,
    trains: [],
  });

  useEffect(() => {
    const arrived = arrive();
    let known: Train[] = [];
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const poll = async () => {
      if (sceneShown()) {
        const url = layerUrl("/api/trains");

        try {
          const response = url ? await fetch(url) : null;

          if (response?.ok) {
            const body: TrainsResponse = await response.json();
            const skew = skewFrom(body.time);
            known = body.trains.map((train) => ({
              ...train,
              time: train.time + skew,
              trail: train.trail.map(([e, n, t]) => [e, n, t + skew]),
            }));
          }
        } catch (e) {
          console.error("[trains]", e);
        }

        known = known.filter((train) => !isStale(train, sceneNow()));

        if (stopped) return;
        setShown({ seek, trains: known });
        arrived();
      }

      timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      arrived();
      clearTimeout(timer);
    };
  }, [seek]);

  // Until the first answer after the clock's set, nothing.
  return shown.seek === seek ? shown.trains : NONE;
}
