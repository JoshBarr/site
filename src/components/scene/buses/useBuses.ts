import { useEffect, useState } from "react";
import { layerUrl, sceneNow, type Seek, skewFrom, useSeek } from "../clock";
import { sceneShown } from "../visibility";
import { isStale } from "../../../lib/buses";
import type { Bus, BusesResponse } from "../../../lib/buses";

export type { Bus };

const NONE: Bus[] = [];

/** As often as /api/buses refreshes. */
const POLL = 10_000;

/**
 * Buses on the road and their trails, polled from /api/buses, which
 * answers with everything it knows each time. A failed poll keeps the last
 * answer. Times are on the scene's clock (../clock.ts); setting it starts
 * over from then.
 */
export function useBuses() {
  const seek = useSeek();

  const [shown, setShown] = useState<{ seek: Seek; buses: Bus[] }>({
    seek,
    buses: [],
  });

  useEffect(() => {
    let known: Bus[] = [];
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const poll = async () => {
      if (sceneShown()) {
        const url = layerUrl("/api/buses");

        try {
          const response = url ? await fetch(url) : null;

          if (response?.ok) {
            const body: BusesResponse = await response.json();
            const skew = skewFrom(body.time);
            known = body.buses.map((bus) => ({
              ...bus,
              time: bus.time + skew,
              trail: bus.trail.map(([e, n, t]) => [e, n, t + skew]),
            }));
          }
        } catch (e) {
          console.error("[buses]", e);
        }

        known = known.filter((bus) => !isStale(bus, sceneNow()));

        if (stopped) return;
        setShown({ seek, buses: known });
      }

      timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [seek]);

  // Until the first answer after the clock's set, nothing.
  return shown.seek === seek ? shown.buses : NONE;
}
