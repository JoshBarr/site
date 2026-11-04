import { useEffect, useRef } from "react";
import { layerUrl, sceneNow, skewFrom, useSeek } from "../clock";
import { sceneShown } from "../visibility";
import type { Quake } from "../../../lib/quakes";
import type { QuakesResponse } from "../../../pages/api/quakes";

/** A quake, and when its ripple starts on the scene's clock: null for none. */
export interface Shown {
  quake: Quake;
  start: number | null;
}

/** As often as GeoNet's polled. */
const POLL = 60_000;

/**
 * Heard of this long after it struck, ms, a quake's ripple plays when it's
 * heard of instead (GeoNet takes a few minutes); any later, it doesn't.
 */
const LATE = 15 * 60_000;

const TRIAL = "trial";

/**
 * ?quake=M,E,N,depth,in (magnitude, NZTM metres, km, seconds) for trying
 * it out: one that strikes `in` seconds (3 unless given) after the clock's
 * set. Null without one.
 */
function trialQuake(): Shown | null {
  const [magnitude, easting, northing, depth = 10, delay = 3] = (
    new URLSearchParams(location.search).get("quake") ?? ""
  )
    .split(",")
    .map(Number);

  if (![magnitude, easting, northing, depth, delay].every(Number.isFinite)) {
    return null;
  }

  const time = sceneNow() + delay * 1000;

  return {
    quake: {
      id: TRIAL,
      time,
      position: [easting, northing],
      depth,
      magnitude,
      locality: "?quake",
      quality: "best",
    },
    start: time,
  };
}

/**
 * The quakes on the map or felt in Wellington, polled from /api/quakes, by
 * GeoNet ID. Replaying, those about to strike come too, so each ripple
 * plays as it struck; live, as it's heard of. Times are on the scene's
 * clock (../clock.ts); setting it starts over from then.
 */
export function useQuakes() {
  const seek = useSeek();
  const shown = useRef(new Map<string, Shown>());

  useEffect(() => {
    const known = new Map<string, Shown>();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let asked = false;

    shown.current = known;

    const trial = trialQuake();

    if (trial) known.set(TRIAL, trial);

    const poll = async () => {
      if (sceneShown() || !asked) {
        const url = layerUrl("/api/quakes", POLL);

        asked = true;

        try {
          const response = url ? await fetch(url) : null;

          if (response?.ok && !stopped) {
            const body: QuakesResponse = await response.json();
            const skew = skewFrom(body.time);
            const heard = sceneNow();
            const ids = new Set<string>();

            for (const reported of body.quakes) {
              const quake = { ...reported, time: reported.time + skew };
              const seen = known.get(quake.id);
              const late = heard - quake.time;

              ids.add(quake.id);

              // Revised as it's reviewed; its ripple, once set, stays.
              known.set(quake.id, {
                quake,
                start: seen
                  ? seen.start
                  : late <= 0
                    ? quake.time
                    : late < LATE
                      ? heard
                      : null,
              });
            }

            // Those GeoNet's dropped: deleted, or older than it keeps.
            for (const id of known.keys()) {
              if (!ids.has(id) && id !== TRIAL) known.delete(id);
            }
          }
        } catch (e) {
          console.error("[quakes]", e);
        }
      }

      if (!stopped) timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [seek]);

  return shown;
}
