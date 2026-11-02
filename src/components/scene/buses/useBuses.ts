import { useEffect, useState } from "react";
import { isStale } from "../../../lib/buses";
import type { Bus, BusesResponse } from "../../../lib/buses";

export type { Bus };

/** As often as /api/buses refreshes. */
const POLL = 10_000;

/**
 * Buses on the road and their trails, polled from /api/buses, which
 * answers with everything it knows each time. A failed poll keeps the last
 * answer. Times are on this browser's clock.
 */
export function useBuses() {
  const [buses, setBuses] = useState<Bus[]>([]);

  useEffect(() => {
    let known: Bus[] = [];
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const poll = async () => {
      if (!document.hidden) {
        try {
          const response = await fetch("/api/buses");

          if (response.ok) {
            const body: BusesResponse = await response.json();
            const skew = Date.now() - body.time;
            known = body.buses.map((bus) => ({
              ...bus,
              time: bus.time + skew,
              trail: bus.trail.map(([e, n, t]) => [e, n, t + skew]),
            }));
          }
        } catch (e) {
          console.error("[buses]", e);
        }

        known = known.filter((bus) => !isStale(bus));

        if (stopped) return;
        setBuses(known);
      }

      timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return buses;
}
