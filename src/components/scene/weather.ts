import { useEffect, useState } from "react";
import type { Conditions } from "../../lib/weather";
import { layerUrl, useSeek } from "./clock";
import { sceneShown } from "./visibility";
import { arrive } from "./time/jump";

export type { Conditions };

/** Used until (or if never) the forecast arrives: a fair-weather northerly. */
const DEFAULT_CONDITIONS: Conditions = {
  time: new Date(0).toISOString(),
  cloudCover: 0.35,
  cloudBase: 900,
  visibility: 30000,
  humidity: 0.7,
  precipitation: 0,
  wind: { speed: 7, direction: 340 },
  windAloft: { speed: 10, direction: 340 },
};

/**
 * Forecast rain below this is dry, mm/h. The model smears trace amounts over
 * sunny afternoons and is rarely exactly 0.
 */
const RAIN_THRESHOLD = 0.3;

function withoutTrace(conditions: Conditions): Conditions {
  return conditions.precipitation < RAIN_THRESHOLD
    ? { ...conditions, precipitation: 0 }
    : conditions;
}

/**
 * URL overrides for trying out weather:
 *   ?cloud=80        cover, percent
 *   ?base=600        cloud base, metres
 *   ?wind=12,320     speed m/s, direction from (both heights)
 *   ?vis=8000        visibility, metres
 *   ?rain=4          rate, mm/h (0 stops it); brings 60% cloud to fall from,
 *                    unless ?cloud says otherwise
 */
function withOverrides(conditions: Conditions): Conditions {
  const params = new URLSearchParams(location.search);

  const number = (name: string) => {
    const value = Number(params.get(name));

    return params.has(name) && Number.isFinite(value) ? value : undefined;
  };

  const next = { ...conditions };

  const cloud = number("cloud");

  if (cloud !== undefined) next.cloudCover = cloud / 100;
  const base = number("base");

  if (base !== undefined) next.cloudBase = base;

  // Tried out, the sky's the one asked for, not the one observed.
  if (cloud !== undefined || base !== undefined) next.layers = null;
  const visibility = number("vis");

  if (visibility !== undefined) next.visibility = visibility;
  const rain = number("rain");

  if (rain !== undefined) {
    next.precipitation = Math.max(rain, 0);

    // Rain only falls from cloud.
    if (rain > 0 && cloud === undefined) {
      next.cloudCover = Math.max(next.cloudCover, 0.6);
    }
  }

  const [speed, direction] = (params.get("wind") ?? "").split(",").map(Number);

  if (
    Number.isFinite(speed) &&
    Number.isFinite(direction) &&
    params.has("wind")
  ) {
    next.wind = { speed, direction };
    next.windAloft = { speed: speed * 1.4, direction };
  }

  return next;
}

/**
 * How often the conditions are asked for again, ms. MetService's are
 * fetched every half hour, the airport's METAR comes each half hour;
 * replaying, a step of this is close enough.
 */
const POLL = 10 * 60_000;

/**
 * MetService's conditions at the scene's time (./clock.ts), with the
 * airport's observations in their place while it has some lately, asked
 * for again as it runs on and when it's set; the defaults until they
 * arrive.
 */
export function useConditions(): Conditions {
  const seek = useSeek();

  const [conditions, setConditions] = useState(() =>
    withOverrides(DEFAULT_CONDITIONS)
  );

  useEffect(() => {
    const arrived = arrive();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let asked = false;
    // The forecast's hour and the observation's time for the conditions
    // shown: the same again isn't news.
    let shown: string | null = null;

    const poll = async () => {
      if (sceneShown() || !asked) {
        const url = layerUrl("/api/weather", POLL);

        asked = true;

        try {
          const response = url ? await fetch(url) : null;

          const latest: Conditions | null = response?.ok
            ? await response.json()
            : null;

          const news = latest
            ? `${latest.time}|${latest.observed ?? ""}`
            : null;

          if (latest && news !== shown && !stopped) {
            shown = news;
            setConditions(withOverrides(withoutTrace(latest)));
          }
        } catch (e) {
          console.error("[weather]", e);
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

  return conditions;
}

/** Base of the low cloud, in metres: reported, or guessed from the cover. */
export function lowCloudBase({ cloudCover, cloudBase }: Conditions) {
  const cover = Math.min(Math.max(cloudCover, 0), 1);

  return Math.min(Math.max(cloudBase ?? 1400 - 700 * cover, 200), 2500);
}

/** Wind as a velocity (x east, z south) from speed and "from" direction. */
export function windVector(speed: number, from: number) {
  const toward = ((from + 180) * Math.PI) / 180;

  return [Math.sin(toward) * speed, -Math.cos(toward) * speed];
}
