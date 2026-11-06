import { useEffect, useMemo, useState } from "react";
import type { StationReading, WindReadings } from "../../../lib/windStations";
import { layerUrl, sceneNow, useSeek } from "../clock";
import { arrive } from "../time/jump";
import { sceneShown } from "../visibility";
import { type Calibration, estimate, type Wind } from "./estimate";

/** /api/wind's readings are asked for every five minutes. */
const POLL = 5 * 60_000;

/** Readings this old are no use, ms: the forecast's better. */
const STALE = 90 * 60_000;

/** How each station's read against the wind at sea (build_stations.py). */
const CALIBRATION_URL = "/wind/stations.json";

/** ?wind=12,320 tries a wind out everywhere, so the stations are left out. */
const overridden = () => new URLSearchParams(location.search).has("wind");

let calibration: Promise<Calibration | null> | null = null;

function loadCalibration() {
  calibration ??= fetch(CALIBRATION_URL)
    .then((response): Promise<Calibration> => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      // Built with the site (scripts/wind/build_stations.py), and checked
      // against its stations (test/lib/windStations.test.ts).
      return response.json();
    })
    .catch((e) => {
      console.error("[wind] calibration:", e);

      return null;
    });

  return calibration;
}

/**
 * GWRC's weather stations at the scene's time (../clock.ts), asked for again
 * as it runs on and when it's set: null until they're heard from, if
 * they've nothing recent, or with ?wind given.
 */
function useWindStations(): StationReading[] | null {
  const seek = useSeek();
  const [readings, setReadings] = useState<StationReading[] | null>(null);

  useEffect(() => {
    if (overridden()) return;

    const arrived = arrive();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let asked = false;
    // When the readings shown were asked: the same again isn't news.
    let shown: number | null = null;

    const poll = async () => {
      if (sceneShown() || !asked) {
        const url = layerUrl("/api/wind", 60_000);

        asked = true;

        try {
          const response = url ? await fetch(url) : null;

          const latest: WindReadings | null = response?.ok
            ? await response.json()
            : null;

          if (!stopped && latest && latest.time !== shown) {
            shown = latest.time;
            setReadings(
              latest.stations.length && sceneNow() - latest.time < STALE
                ? latest.stations
                : null
            );
          }
        } catch (e) {
          console.error("[wind]", e);
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

  return readings;
}

/**
 * The wind out at sea: `forecast`'s, set right by what GWRC's weather
 * stations are measuring (./estimate.ts), once they've been heard from.
 */
export function useMeasuredWind(forecast: Wind): Wind {
  const readings = useWindStations();
  const [known, setKnown] = useState<Calibration | null>(null);

  useEffect(() => {
    if (!readings || known) return;
    let stopped = false;

    loadCalibration().then((loaded) => !stopped && setKnown(loaded));

    return () => {
      stopped = true;
    };
  }, [readings, known]);

  return useMemo(() => {
    if (!readings || !known) return forecast;

    const { speed, direction, stations } = estimate(forecast, readings, known);

    if (!stations) return forecast;

    // Rounded, so a reading that barely moves it doesn't redraw what it drives.
    return {
      speed: Math.round(speed * 10) / 10,
      direction: Math.round(direction),
    };
  }, [forecast, readings, known]);
}
