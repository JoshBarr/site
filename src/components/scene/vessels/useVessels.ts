import { useEffect, useState } from "react";
import { layerUrl, sceneNow, type Seek, skewFrom, useSeek } from "../clock";
import { sceneShown } from "../visibility";
import { isStale } from "../../../lib/vessels";
import type { Vessel, VesselsResponse } from "../../../lib/vessels";

export type { Vessel };

const NONE: Vessel[] = [];

/** As often as /api/vessels refreshes. */
const POLL = 20_000;

/**
 * Ships in the harbour and their trails, polled from /api/vessels, which
 * answers with everything it knows each time. A failed poll keeps the last
 * answer. Times are on the scene's clock (../clock.ts); setting it starts
 * over from then.
 */
export function useVessels() {
  const seek = useSeek();

  const [shown, setShown] = useState<{ seek: Seek; vessels: Vessel[] }>({
    seek,
    vessels: [],
  });

  useEffect(() => {
    let known: Vessel[] = [];
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const poll = async () => {
      if (sceneShown()) {
        const url = layerUrl("/api/vessels");

        try {
          const response = url ? await fetch(url) : null;

          if (response?.ok) {
            const body: VesselsResponse = await response.json();
            const skew = skewFrom(body.time);
            known = body.vessels.map((vessel) => ({
              ...vessel,
              time: vessel.time + skew,
              trail: vessel.trail.map(([e, n, t]) => [e, n, t + skew]),
            }));
          }
        } catch (e) {
          console.error("[vessels]", e);
        }

        known = known.filter((vessel) => !isStale(vessel, sceneNow()));

        if (stopped) return;
        setShown({ seek, vessels: known });
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
  return shown.seek === seek ? shown.vessels : NONE;
}
