import { useEffect, useState } from "react";
import {
  byteRate,
  type Radar,
  RADAR_SIZE,
  type RadarScan,
} from "../../lib/radarGrid";
import { layerUrl, sceneNow, useSeek } from "./clock";
import type { RadarRates } from "./clouds/rainField";
import { switchedOff } from "./stats";
import { arrive } from "./time/jump";
import { sceneShown } from "./visibility";

/** /api/radar is asked every two minutes: there's a frame every ten. */
const POLL = 2 * 60_000;

/**
 * Scans this old are no use, ms: the radar's gone quiet, or the poller
 * has, and the showers have moved on.
 */
const STALE = 40 * 60_000;

/**
 * ?rain=4 tries a rate out everywhere, so the radar's left out with the
 * gauges; ?off=radar leaves it out to compare.
 */
const overridden = () =>
  new URLSearchParams(location.search).has("rain") || switchedOff("radar");

/** Each byte's rate, mm/h. */
const RATES = Float32Array.from({ length: 256 }, (_, byte) => byteRate(byte));

/** A scan's rates, if its cells are the grid's size. */
function ratesOf({ time, cells }: RadarScan): RadarRates | null {
  const bytes = atob(cells);

  if (bytes.length !== RADAR_SIZE * RADAR_SIZE) return null;

  return {
    time,
    rates: Float32Array.from(
      { length: bytes.length },
      (_, k) => RATES[bytes.charCodeAt(k)]
    ),
  };
}

/**
 * What the rain radar's seen over the last half hour at the scene's time
 * (./clock.ts), oldest scan first, asked for again as it runs on and when
 * it's set: null until it's heard from, once its newest is old, or with
 * the rain overridden.
 */
export function useRadar(): RadarRates[] | null {
  const seek = useSeek();
  const [scans, setScans] = useState<RadarRates[] | null>(null);

  useEffect(() => {
    if (overridden()) return;

    const arrived = arrive();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let asked = false;
    // The scans shown, and when the newest was: the same again isn't news.
    let shown: RadarRates[] | null = null;

    const poll = async () => {
      if (sceneShown() || !asked) {
        const url = layerUrl("/api/radar", 60_000);

        asked = true;

        try {
          const response = url ? await fetch(url) : null;

          const latest: Radar | null = response?.ok
            ? await response.json()
            : null;

          if (!stopped && latest) {
            if (latest.scans.at(-1)?.time !== shown?.at(-1)?.time) {
              shown = latest.scans.flatMap((scan) => ratesOf(scan) ?? []);
            }

            const newest = shown?.at(-1);

            // Asked again, the same scans may have gone stale.
            setScans(
              shown && newest && sceneNow() - newest.time < STALE ? shown : null
            );
          }
        } catch (e) {
          console.error("[radar]", e);
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

  return scans;
}
