import { useEffect, useState } from "react";
import type { Gauge, Rainfall } from "../../lib/rainGauges";
import { layerUrl, sceneNow, useSeek } from "./clock";
import { sceneShown } from "./visibility";
import { arrive } from "./time/jump";

export type { Gauge };

/** /api/rain's gauges are read every five minutes. */
const POLL = 5 * 60_000;

/**
 * Rates this old are no use, ms: the gauges have gone quiet, or the poller
 * has, and the forecast's better than an hour-old shower.
 */
const STALE = 60 * 60_000;

/** ?rain=4 tries a rate out everywhere, so the gauges are left out. */
const overridden = () => new URLSearchParams(location.search).has("rain");

/**
 * GWRC's rain gauges on the map at the scene's time (./clock.ts), asked for
 * again as it runs on and when it's set: null until they're heard from, if
 * they've nothing recent, or with ?rain given.
 */
export function useRainGauges(): Gauge[] | null {
  const seek = useSeek();
  const [gauges, setGauges] = useState<Gauge[] | null>(null);

  useEffect(() => {
    if (overridden()) return;

    const arrived = arrive();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let asked = false;
    // When the gauges shown were asked: the same again isn't news.
    let shown: number | null = null;

    const poll = async () => {
      if (sceneShown() || !asked) {
        const url = layerUrl("/api/rain", 60_000);

        asked = true;

        try {
          const response = url ? await fetch(url) : null;

          const latest: Rainfall | null = response?.ok
            ? await response.json()
            : null;

          if (!stopped && latest && latest.time !== shown) {
            shown = latest.time;
            setGauges(
              latest.gauges.length && sceneNow() - latest.time < STALE
                ? latest.gauges
                : null
            );
          }
        } catch (e) {
          console.error("[rain]", e);
        }

        arrived();
      }

      if (!stopped) timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      arrived();
      clearTimeout(timer);
    };
  }, [seek]);

  return gauges;
}
