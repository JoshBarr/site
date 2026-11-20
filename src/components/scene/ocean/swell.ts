import { useEffect, useState } from "react";
import type { Waves } from "../../../lib/waves";
import { layerUrl, sceneNow, useSeek } from "../clock";
import { sceneShown } from "../visibility";
import { arrive } from "../time/jump";
import type { OceanConditions, Sea } from "./spectrum";

// The open sea as GWRC's wave buoy off Baring Head measures it (see
// lib/waves.ts), in place of the guess the wind gives: a big southerly
// swell on a still morning, or a flat strait under a northerly gale, are
// both the buoy's to say.

/** /api/waves' buoy is read every ten minutes; it reports every half hour. */
const POLL = 10 * 60_000;

/**
 * A reading this old says nothing of the sea now, ms: the buoy's off
 * station or the poller's stopped, and the wind's guess is better.
 */
const STALE = 3 * 3600_000;

/**
 * The buoy's period is that of the highest third of the waves; a sea's
 * peak is a little longer. For a wind sea's spectrum they're about this
 * far apart (Goda).
 */
const SIGNIFICANT_OF_PEAK = 0.93;

/**
 * ?swell=3.5,11,185 tries a sea out: its significant height (m), peak
 * period (s) and where it's from (degrees). ?swell=wind leaves the buoy
 * out, for the sea the wind alone would be given. Undefined without either.
 */
function override(): Sea | null | undefined {
  const value = new URLSearchParams(location.search).get("swell");

  if (value === null) return undefined;

  const [height, period, direction] = value.split(",").map(Number);

  return [height, period, direction].every(Number.isFinite) &&
    height > 0 &&
    period > 0
    ? { height, period, direction }
    : null;
}

/** The open sea a reading tells of at `now` (epoch ms); null if it's too old. */
export function measuredSea(waves: Waves, now: number): Sea | null {
  if (!(now - waves.time < STALE) || !(waves.height > 0)) return null;

  return {
    height: waves.height,
    period: waves.period / SIGNIFICANT_OF_PEAK,
    direction: waves.direction,
  };
}

/**
 * Sea state from the wind, and the open sea from the buoy if it's been
 * heard from. Without it the open sea's guessed from the wind's fetch, the
 * open water it has blown across, which depends on where it comes from:
 * southerlies arrive off the Southern Ocean, northerlies through Cook
 * Strait.
 */
export function seaConditions(
  wind: { speed: number; direction: number },
  measured: Sea | null
): OceanConditions {
  const southerly = wind.direction > 120 && wind.direction < 240;

  return {
    windSpeed: wind.speed,
    windDirection: wind.direction,
    fetch: southerly ? 500000 : 80000,
    swell: southerly ? 0.6 : 0.3,
    sea: measured,
  };
}

/**
 * The open sea at the scene's time (../clock.ts) by the wave buoy, asked
 * for again as it runs on and when it's set: null until it's heard from,
 * if what it last said is old, or with ?swell=wind; ?swell's own sea if
 * it gives one.
 */
export function useSwell(): Sea | null {
  const seek = useSeek();
  const [sea, setSea] = useState<Sea | null>(null);

  useEffect(() => {
    const tried = override();

    if (tried !== undefined) {
      setSea(tried);

      return;
    }

    const arrived = arrive();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let asked = false;
    // When the reading shown was taken: the same again isn't news.
    let shown: number | null = null;

    const poll = async () => {
      if (sceneShown() || !asked) {
        const url = layerUrl("/api/waves", 5 * 60_000);

        asked = true;

        try {
          const response = url ? await fetch(url) : null;

          const latest: Waves | null = response?.ok
            ? await response.json()
            : null;

          if (!stopped && latest && latest.time !== shown) {
            shown = latest.time;
            setSea(measuredSea(latest, sceneNow()));
          }
        } catch (e) {
          console.error("[waves]", e);
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

  return sea;
}
