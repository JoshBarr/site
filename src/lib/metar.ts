import { z } from "zod";
import { readJson } from "./schemas";
import type { Conditions } from "./weather";

// Wellington Airport's METAR: what its automatic weather station measures
// every half hour (temperature, dewpoint, visibility, and the cloud its
// ceilometer sees overhead, layer by layer), from NOAA's Aviation Weather
// Center, no key. The forecast's cloud and temperature can be hours behind
// the sky; while there's an observation lately, it goes by that instead.

const LATEST =
  "https://aviationweather.gov/api/data/metar?ids=NZWN&format=json&hours=2";

const TIMEOUT = 15_000;

/** The aerodrome's height, m: METAR cloud bases are above it. */
const ELEVATION = 12;

const FEET = 0.3048;

/**
 * How much of the sky each amount is, as the METAR counts it: in eighths,
 * FEW 1–2, SCT 3–4, BKN 5–7, OVC 8, each taken at its middle. An obscured
 * sky (VV, fog) is overcast at the vertical visibility.
 */
const COVER = { FEW: 1.5 / 8, SCT: 3.5 / 8, BKN: 6 / 8, OVC: 1, VV: 1 };

/** "9999": ten kilometres or more. */
const TEN_KM = 10_000;

/** Groups after these are forecast, remarks: not what's observed. */
const STOP = new Set(["RMK", "TEMPO", "BECMG", "NOSIG", "INTER"]);

export interface CloudLayer {
  /**
   * 0..1 of the sky, as a METAR counts it: all the cloud at and below this
   * layer, so it's never less than the layers under it.
   */
  cover: number;
  /** Its base, m above sea level. */
  base: number;
}

export interface Observation {
  /** When it was observed, epoch ms. */
  time: number;
  /** °C. */
  temperature: number | null;
  /** °C. */
  dewpoint: number | null;
  /** m, TEN_KM for ten kilometres or more; null when not reported. */
  visibility: number | null;
  /** Lowest first; empty for none seen (CAVOK, NCD, NSC). */
  clouds: CloudLayer[];
  /** What's falling or hanging in the air, as reported: "-RA", "BR". */
  weather: string[];
  /** The report as sent. */
  raw: string;
}

const CLOUD = /^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU|\/\/\/)?$/;

const WEATHER =
  /^(\+|-|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+$/;

const TEMPERATURE = /^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$/;

const celsius = (group: string | undefined) =>
  group && /^M?\d{2}$/.test(group)
    ? (group.startsWith("M") ? -1 : 1) * Number(group.replace("M", ""))
    : null;

/**
 * What a METAR says, observed at `time` (epoch ms): its date's only a day
 * of the month, so it's left to the caller.
 */
export function parseMetar(raw: string, time: number): Observation {
  const observation: Observation = {
    time,
    temperature: null,
    dewpoint: null,
    visibility: null,
    clouds: [],
    weather: [],
    raw: raw.trim(),
  };

  for (const group of raw.trim().split(/\s+/)) {
    if (STOP.has(group)) break;

    if (group === "CAVOK") {
      observation.visibility = TEN_KM;
      continue;
    }

    // The first is the prevailing visibility; one after is the least.
    if (/^\d{4}(NDV|[NSEW]{1,2})?$/.test(group)) {
      const metres = Number(group.slice(0, 4));

      observation.visibility ??= metres >= 9999 ? TEN_KM : metres;
      continue;
    }

    const cloud = CLOUD.exec(group);

    if (cloud) {
      const [, amount, hundreds] = cloud;

      observation.clouds.push({
        // SAFETY: CLOUD only matches COVER's amounts.
        cover: COVER[amount as keyof typeof COVER],
        base: Math.round(Number(hundreds) * 100 * FEET + ELEVATION),
      });

      continue;
    }

    if (WEATHER.test(group)) {
      observation.weather.push(group);
      continue;
    }

    const temperature = TEMPERATURE.exec(group);

    if (temperature) {
      observation.temperature = celsius(temperature[1]);
      observation.dewpoint = celsius(temperature[2]);
    }
  }

  // Each counts what's under it too, even where the report rounds lower.
  let under = 0;

  for (const layer of observation.clouds) {
    layer.cover = Math.max(layer.cover, under);
    under = layer.cover;
  }

  return observation;
}

const reports = z.array(z.object({ obsTime: z.number(), rawOb: z.string() }));

/** The airport's newest METAR from the last two hours; null if there's none. */
export async function fetchMetar(): Promise<Observation | null> {
  const response = await fetch(LATEST, {
    headers: { "User-Agent": "joshbarr.com scene" },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`metar: HTTP ${response.status}`);

  // No reports is an empty body, not [].
  if (response.status === 204) return null;

  const newest = (await readJson(response, reports, "metar")).reduce<
    z.infer<typeof reports>[number] | null
  >((a, b) => (a && a.obsTime >= b.obsTime ? a : b), null);

  return newest && parseMetar(newest.rawOb, newest.obsTime * 1000);
}

/**
 * An observation's no use this long after, ms: one's sent every half hour,
 * so this allows one to go missing.
 */
const OBSERVED_FRESH = 75 * 60_000;

/**
 * With nothing seen overhead, the forecast's cover is let through up to
 * this: the ceilometer doesn't see high cloud. A guess.
 */
const UNSEEN_COVER = 0.2;

/** Relative humidity, 0..1, from temperature and dewpoint (Magnus). */
export function humidityOf(temperature: number, dewpoint: number) {
  const magnus = (t: number) => Math.exp((17.625 * t) / (243.04 + t));

  return Math.min(Math.max(magnus(dewpoint) / magnus(temperature), 0), 1);
}

/**
 * `forecast` with what the airport observed lately as of `now` (epoch ms)
 * in its place: temperature, humidity, visibility and the cloud's layers
 * and cover. The wind and rain are measured better elsewhere. Without a
 * recent observation, it's the forecast.
 */
export function withObserved(
  forecast: Conditions,
  observed: Observation | null | undefined,
  now: number
): Conditions {
  if (
    !observed ||
    now - observed.time > OBSERVED_FRESH ||
    observed.time > now + 60_000
  ) {
    return forecast;
  }

  const { temperature, dewpoint, visibility, clouds } = observed;
  // As a METAR counts it, the highest layer's cover is all of it.
  const seen = clouds.at(-1)?.cover ?? 0;

  return {
    ...forecast,
    temperature: temperature ?? forecast.temperature,
    humidity:
      temperature !== null && dewpoint !== null
        ? humidityOf(temperature, dewpoint)
        : forecast.humidity,
    // Ten kilometres is as far as a METAR says.
    visibility:
      visibility === null
        ? forecast.visibility
        : visibility >= TEN_KM
          ? Math.max(forecast.visibility, TEN_KM)
          : visibility,
    cloudCover: clouds.length
      ? seen
      : Math.min(forecast.cloudCover, UNSEEN_COVER),
    cloudBase: clouds[0]?.base ?? null,
    layers: clouds,
    observed: observed.time,
  };
}
