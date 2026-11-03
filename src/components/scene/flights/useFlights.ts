import { useEffect, useState } from "react";
import { layerUrl, sceneNow, type Seek, skewFrom, useSeek } from "../clock";
import { sceneShown } from "../visibility";
import { HISTORY } from "../../../lib/flights";
import type { Aircraft, FlightsResponse } from "../../../lib/flights";

export type { Aircraft };

const POLL = 10_000;

/**
 * Wellington Airport's curfew, NZ time: [hour, minute] from and to. Nothing
 * scheduled flies, so polls slow down, but they don't stop: medevac and
 * freight flights still come and go.
 */
const CURFEW = { from: [1, 0], to: [5, 30] };
const CURFEW_POLL = 120_000;

function inCurfew(date: Date) {
  const [hour, minute] = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  })
    .format(date)
    .split(":")
    .map(Number);

  const now = hour * 60 + minute;
  const minutes = ([h, m]: number[]) => h * 60 + m;

  return now >= minutes(CURFEW.from) && now < minutes(CURFEW.to);
}

export interface Flights {
  aircraft: Aircraft[];
  /** The scene's clock minus the server's, ms. Fixes are server time. */
  skew: number;
}

const NONE: Flights = { aircraft: [], skew: 0 };

/**
 * Aircraft around Wellington and their trails, polled from /api/flights. The
 * first poll fetches HISTORY's worth of fixes; later ones only recent fixes,
 * which are merged in. At the scene's time (../clock.ts): setting the clock
 * starts over from then.
 */
export function useFlights(): Flights {
  const seek = useSeek();

  const [shown, setShown] = useState<{ seek: Seek; flights: Flights }>({
    seek,
    flights: NONE,
  });

  useEffect(() => {
    const known = new Map<string, Aircraft>();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let history = true;
    let skew = 0;

    const poll = async () => {
      if (sceneShown()) {
        const url = layerUrl(history ? "/api/flights?history" : "/api/flights");

        try {
          const response = url ? await fetch(url) : null;

          if (response?.ok) {
            const body: FlightsResponse = await response.json();
            skew = skewFrom(body.time);

            for (const { fixes, ...details } of body.aircraft) {
              const before = known.get(details.hex);

              const merged = new Map(
                (before?.fixes ?? []).map((f) => [f[3], f])
              );

              for (const fix of fixes) merged.set(fix[3], fix);
              known.set(details.hex, {
                ...details,
                // A lookup that failed this time keeps the last answer.
                route:
                  details.route === undefined ? before?.route : details.route,
                fixes: [...merged.values()].sort((a, b) => a[3] - b[3]),
              });
            }

            history = false;
          }
        } catch (e) {
          console.error("[flights]", e);
        }

        const oldest = sceneNow() - skew - HISTORY;

        for (const [hex, plane] of known) {
          plane.fixes = plane.fixes.filter((fix) => fix[3] > oldest);

          if (!plane.fixes.length) known.delete(hex);
        }

        if (stopped) return;
        setShown({ seek, flights: { aircraft: [...known.values()], skew } });
      } else {
        // Hidden or scrolled away: catch up on what's missed when back.
        history = true;
      }

      timer = setTimeout(
        poll,
        inCurfew(new Date(sceneNow())) ? CURFEW_POLL : POLL
      );
    };

    poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [seek]);

  // Until the first answer after the clock's set, nothing.
  return shown.seek === seek ? shown.flights : NONE;
}
