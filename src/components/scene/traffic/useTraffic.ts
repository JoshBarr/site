import { useEffect, useState } from "react";
import { layerUrl, useSeek } from "../clock";
import type { Seek } from "../clock";
import { sceneShown } from "../visibility";
import { STALE } from "../../../lib/traffic";
import type { TrafficResponse, TrafficSpeeds } from "../../../lib/traffic";
import { arrive } from "../time/jump";

/** NZTA's speeds move every minute or two; /api/traffic refreshes each minute. */
const POLL = 60_000;

/**
 * NZTA's speeds on SH1 and SH2, polled from /api/traffic: null until the
 * first answer, or when the last good one's gone stale. `ready` once the
 * first poll's done, answered or not, so traffic can start without. At the
 * scene's time (../clock.ts): setting the clock asks again for then, and
 * `seek` is the setting the speeds are for.
 */
export function useTraffic() {
  const seek = useSeek();

  const [state, setState] = useState<{
    speeds: TrafficSpeeds | null;
    ready: boolean;
    seek: Seek;
  }>({ speeds: null, ready: false, seek });

  useEffect(() => {
    const arrived = arrive();
    let known: TrafficResponse | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const poll = async () => {
      if (sceneShown() || !known) {
        const url = layerUrl("/api/traffic");

        try {
          const response = url ? await fetch(url) : null;

          if (response?.ok) known = await response.json();
        } catch (e) {
          console.error("[traffic]", e);
        }

        if (stopped) return;

        const fresh =
          known && known.time - known.fetched < STALE ? known : null;

        setState((last) =>
          last.ready && last.speeds === fresh && last.seek === seek
            ? last
            : { speeds: fresh, ready: true, seek }
        );
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

  return state;
}
