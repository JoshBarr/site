import { useEffect, useState } from "react";
import { sceneShown } from "../visibility";
import { isStale } from "../../../lib/vessels";
import type { Vessel, VesselsResponse } from "../../../lib/vessels";

export type { Vessel };

/** As often as /api/vessels refreshes. */
const POLL = 20_000;

/**
 * Ships in the harbour and their trails, polled from /api/vessels, which
 * answers with everything it knows each time. A failed poll keeps the last
 * answer. Times are on this browser's clock.
 */
export function useVessels() {
  const [vessels, setVessels] = useState<Vessel[]>([]);

  useEffect(() => {
    let known: Vessel[] = [];
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const poll = async () => {
      if (sceneShown()) {
        try {
          const response = await fetch("/api/vessels");

          if (response.ok) {
            const body: VesselsResponse = await response.json();
            const skew = Date.now() - body.time;
            known = body.vessels.map((vessel) => ({
              ...vessel,
              time: vessel.time + skew,
              trail: vessel.trail.map(([e, n, t]) => [e, n, t + skew]),
            }));
          }
        } catch (e) {
          console.error("[vessels]", e);
        }

        known = known.filter((vessel) => !isStale(vessel));

        if (stopped) return;
        setVessels(known);
      }

      timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return vessels;
}
