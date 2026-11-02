import { useEffect, useState } from "react";
import { sceneShown } from "../visibility";
import { STALE } from "../../../lib/traffic";
import type { TrafficResponse, TrafficSpeeds } from "../../../lib/traffic";

/** NZTA's speeds move every minute or two; /api/traffic refreshes each minute. */
const POLL = 60_000;

/**
 * NZTA's speeds on SH1 and SH2, polled from /api/traffic: null until the
 * first answer, or when the last good one's gone stale. `ready` once the
 * first poll's done, answered or not, so traffic can start without.
 */
export function useTraffic() {
  const [state, setState] = useState<{
    speeds: TrafficSpeeds | null;
    ready: boolean;
  }>({ speeds: null, ready: false });

  useEffect(() => {
    let known: TrafficResponse | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const poll = async () => {
      if (sceneShown() || !known) {
        try {
          const response = await fetch("/api/traffic");

          if (response.ok) known = await response.json();
        } catch (e) {
          console.error("[traffic]", e);
        }

        if (stopped) return;

        const fresh =
          known && known.time - known.fetched < STALE ? known : null;

        setState((last) =>
          last.ready && last.speeds === fresh
            ? last
            : { speeds: fresh, ready: true }
        );
      }

      timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return state;
}
