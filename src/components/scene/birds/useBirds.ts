import { useEffect, useState } from "react";
import type { BirdsResponse } from "../../../pages/api/birds";
import { layerUrl, useSeek } from "../clock";
import { arrive } from "../time/jump";

/** Live, asked again after this: the summary's remade every three hours. */
const REFRESH = 3_600_000;

/** After a failure, ms. */
const RETRY = 60_000;

/** Replays ask on whole three hours: it's summed up that often. */
const STEP = 3 * 3_600_000;

/**
 * Where the flocks gather, from /api/birds: as last summed up before the
 * scene's time. Null until it's answered, or when the scene's further back
 * than the checklists go; a failed fetch keeps the last.
 */
export function useBirds() {
  const seek = useSeek();
  const [birds, setBirds] = useState<BirdsResponse | null>(null);

  useEffect(() => {
    const arrived = arrive();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const load = async () => {
      let next = RETRY;
      const url = layerUrl("/api/birds", STEP);

      try {
        const response = url ? await fetch(url) : null;

        if (!url) {
          setBirds(null);
          next = REFRESH;
        } else if (response?.ok) {
          const body: BirdsResponse = await response.json();

          if (stopped) return;
          setBirds(body);
          next = REFRESH;
        }
      } catch (e) {
        console.error("[birds]", e);
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

  return birds;
}
