import { useEffect, useState } from "react";
import type { SatellitesResponse } from "../../../pages/api/satellites";
import { layerUrl, useSeek } from "../clock";
import { arrive } from "../time/jump";
import { type Satellite, satellitesFrom } from "./orbits";

/** Live, asked again after this for the morning's new ones, ms. */
const REFRESH = 6 * 3_600_000;

/** After a failure, ms. */
const RETRY = 60_000;

/** Replays ask for a whole day's: the orbits are fetched daily. */
const DAY = 86_400_000;

/**
 * The visual satellites, ready to run, from /api/satellites: those fetched
 * last before the scene's time. Empty until it's answered, or when the
 * scene's further back than the logs go; a failed fetch keeps the last.
 */
export function useSatellites() {
  const seek = useSeek();
  const [satellites, setSatellites] = useState<Satellite[]>([]);

  useEffect(() => {
    const arrived = arrive();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const load = async () => {
      let next = RETRY;
      const url = layerUrl("/api/satellites", DAY);

      try {
        const response = url ? await fetch(url) : null;

        if (!url) {
          setSatellites([]);
          next = REFRESH;
        } else if (response?.ok) {
          const body: SatellitesResponse = await response.json();

          if (stopped) return;
          setSatellites(satellitesFrom(body.orbits));
          next = REFRESH;
        }
      } catch (e) {
        console.error("[satellites]", e);
      }

      arrived();

      if (!stopped) timer = setTimeout(load, next);
    };

    load();

    return () => {
      stopped = true;
      arrived();
      clearTimeout(timer);
    };
  }, [seek]);

  return satellites;
}
