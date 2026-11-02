import { useEffect, useState } from "react";
import { isStale } from "../../../lib/trains";
import type { Train, TrainsResponse } from "../../../lib/trains";

export type { Train };

/** As often as /api/trains refreshes. */
const POLL = 10_000;

/**
 * Trains on the network and their trails, polled from /api/trains, which
 * answers with everything it knows each time. A failed poll keeps the last
 * answer. Times are on this browser's clock.
 */
export function useTrains() {
  const [trains, setTrains] = useState<Train[]>([]);

  useEffect(() => {
    let known: Train[] = [];
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const poll = async () => {
      if (!document.hidden) {
        try {
          const response = await fetch("/api/trains");

          if (response.ok) {
            const body: TrainsResponse = await response.json();
            const skew = Date.now() - body.time;
            known = body.trains.map((train) => ({
              ...train,
              time: train.time + skew,
              trail: train.trail.map(([e, n, t]) => [e, n, t + skew]),
            }));
          }
        } catch (e) {
          console.error("[trains]", e);
        }

        known = known.filter((train) => !isStale(train));

        if (stopped) return;
        setTrains(known);
      }

      timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return trains;
}
