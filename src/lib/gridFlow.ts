import { z } from "zod";
import { readJson } from "./schemas";

// What the national grid's carrying around Wellington, for the scene's
// pylons, wires and Cook Strait cables (components/scene/power):
//
//   The HVDC link's transfer, from the live data on Transpower's website
//   (https://www.transpower.co.nz/system-operator/live-system-and-market-data,
//   which says it's sourced from em6): no key, each half-hour trading
//   period's, posted half an hour or so after it starts. The site's terms
//   reserve its contents; it isn't open data like Transpower's GIS layers.
//
//   The North Island's load, from the same page: no key, every five
//   minutes. It stands in for each substation's load when there's no key
//   for those.
//
//   Each grid exit point's load, and what the wind farms are sending out,
//   from the Electricity Authority's real-time dispatch API
//   (https://emi.developer.azure-api.net, CC BY 4.0): every five minutes, with
//   a subscription key (free, to the "Wholesale market prices" product,
//   approved by hand) in LIVE_EMI_KEY. Without one it's left out.

const TRANSPOWER = "https://www.transpower.co.nz";
const HVDC = `${TRANSPOWER}/em6/data/hvdc`;
const SUMMARY = `${TRANSPOWER}/so/data/live_data_summary`;
const DISPATCH = "https://emi.azure-api.net/real-time-dispatch/";

const TIMEOUT = 10_000;

/** A trading period, ms. */
const PERIOD = 30 * 60_000;

/**
 * Transpower's sites on the map with load or generation of their own, by
 * the code its points of connection start with: Central Park, Gracefield,
 * Haywards, Kaiwharawhara, Melling, Pauatahanui, Takapu Road, Upper Hutt,
 * Wilton (and Mill Creek's wind farm, which comes in at its 33 kV) and
 * West Wind.
 */
export const SITES = [
  "CPK",
  "GFD",
  "HAY",
  "KWA",
  "MLG",
  "PNI",
  "TKR",
  "UHT",
  "WIL",
  "WWD",
] as const;

export type SiteCode = (typeof SITES)[number];

export interface Reading {
  /** When it's for, epoch ms. */
  time: number;
  /** Megawatts. */
  mw: number;
}

export interface SiteReadings {
  /** When they were dispatched, epoch ms. */
  time: number;
  /** MW taken off the grid at each site, by its code. */
  load: Partial<Record<SiteCode, number>>;
  /** MW sent out onto it. */
  generation: Partial<Record<SiteCode, number>>;
}

export interface GridFlow {
  /** The HVDC link's transfer: northward positive, southward negative. */
  hvdc: Reading | null;
  /** The North Island's load. */
  northIsland: Reading | null;
  /** Each site's load and generation; null without a key for them. */
  sites: SiteReadings | null;
}

const client = { "User-Agent": "joshbarr.com scene" };

async function get(url: string, headers: Record<string, string>, name: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);

  return response;
}

/** A period's flow, MW: [when (as the chart wants it), how much]. */
const flows = z.array(z.tuple([z.unknown(), z.number().nullable()]));

const hvdc = z.object({
  /** When the newest period's for, epoch seconds. */
  last_import: z.number(),
  data: z.object({ dcn_flow: flows, dcs_flow: flows }),
});

/**
 * The HVDC link's transfer over the newest trading period that has one;
 * null if none does.
 */
export async function fetchHvdc(): Promise<Reading | null> {
  const { last_import, data } = await readJson(
    await get(HVDC, client, "transpower hvdc"),
    hvdc,
    "transpower hvdc"
  );

  // Each list ends at the newest period: back from there to one measured.
  for (let back = 0; back < data.dcn_flow.length; back++) {
    const north = data.dcn_flow.at(-1 - back)?.[1];
    const south = data.dcs_flow.at(-1 - back)?.[1];

    if (north === null || north === undefined) continue;

    return {
      time: last_import * 1000 - back * PERIOD,
      mw: Math.round(north - (south ?? 0)),
    };
  }

  return null;
}

const summary = z.object({
  /** A table, as the page shows it. */
  content: z.string(),
  /** NZ's wall clock: "2026-11-20 19:50". */
  datetime: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d$/),
});

const nzClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Pacific/Auckland",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** What NZ's clocks read at `time`, as if that were UTC: epoch ms. */
function wallClock(time: number) {
  const part = Object.fromEntries(
    nzClock.formatToParts(time).map(({ type, value }) => [type, value])
  );

  return Date.parse(
    `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:00Z`
  );
}

/** When NZ's clocks read `wall` ("2026-11-20 19:50"), epoch ms. */
export function nzTime(wall: string) {
  const read = Date.parse(`${wall.replace(" ", "T")}:00Z`);
  let time = read;

  // Back by NZ's offset then: twice, in case daylight saving's changed
  // between.
  for (let i = 0; i < 2; i++) time = read - (wallClock(time) - time);

  return time;
}

/** The North Island's load now; null if the page's table hasn't got it. */
export async function fetchIslandLoad(): Promise<Reading | null> {
  const { content, datetime } = await readJson(
    await get(SUMMARY, client, "transpower load"),
    summary,
    "transpower load"
  );

  const found = /NI Total:\s*<\/td>\s*<td[^>]*>\s*(\d+(?:\.\d+)?)\s*MW/.exec(
    content
  );

  return found && { time: nzTime(datetime), mw: Number(found[1]) };
}

const dispatched = z.array(
  z.object({
    PointOfConnectionCode: z.string(),
    /** UTC, without saying so. */
    RunDateTime: z.string(),
    SPDLoadMegawatt: z.number().nullable(),
    SPDGenerationMegawatt: z.number().nullable(),
  })
);

const isSite = (code: string): code is SiteCode =>
  SITES.some((site) => site === code);

/**
 * Each site's load and generation in the newest five minutes dispatched,
 * summed over its points of connection (Central Park's 11 and 33 kV, say);
 * null if none of them were. `key` is the subscription's.
 */
export async function fetchSites(key: string): Promise<SiteReadings | null> {
  const rows = await readJson(
    await get(DISPATCH, { "Ocp-Apim-Subscription-Key": key }, "emi dispatch"),
    dispatched,
    "emi dispatch"
  );

  const ran = ({ RunDateTime }: (typeof rows)[number]) =>
    Date.parse(`${RunDateTime.replace(/Z$/, "")}Z`);

  const run = Math.max(...rows.map(ran).filter(Number.isFinite));
  const load: SiteReadings["load"] = {};
  const generation: SiteReadings["generation"] = {};

  for (const row of rows) {
    const site = row.PointOfConnectionCode.slice(0, 3);

    // Not on the map; or an older run's, should the answer ever hold two.
    if (!isSite(site) || ran(row) !== run) continue;

    load[site] = (load[site] ?? 0) + (row.SPDLoadMegawatt ?? 0);

    generation[site] =
      (generation[site] ?? 0) + (row.SPDGenerationMegawatt ?? 0);
  }

  // To a tenth of a megawatt.
  for (const sums of [load, generation]) {
    for (const site of SITES) {
      const sum = sums[site];

      if (sum !== undefined) sums[site] = Math.round(sum * 10) / 10;
    }
  }

  return Object.keys(load).length ? { time: run, load, generation } : null;
}

const newer = (
  now: { time: number } | null,
  before: { time: number } | null | undefined
) => now !== null && now.time > (before?.time ?? -Infinity);

/**
 * What the grid's carrying, with whatever couldn't be fetched as `previous`
 * had it; null if none of it is newer than that. Throws if nothing could be
 * fetched at all.
 */
export async function fetchGridFlow(
  previous: GridFlow | null
): Promise<GridFlow | null> {
  const key = process.env.LIVE_EMI_KEY;

  const [link, island, sites] = await Promise.allSettled([
    fetchHvdc(),
    fetchIslandLoad(),
    key ? fetchSites(key) : Promise.resolve(null),
  ]);

  const failed = [link, island, sites].flatMap((part) =>
    part.status === "rejected" ? [part.reason] : []
  );

  if (failed.length === 3 || (!key && failed.length === 2)) throw failed[0];

  for (const reason of failed) console.error("[grid] fetch failed:", reason);

  // What failed, or had nothing, stays as it was: the scene tells how old
  // each is.
  const kept = <T>(part: PromiseSettledResult<T | null>, before: T | null) =>
    (part.status === "fulfilled" ? part.value : null) ?? before;

  const flow: GridFlow = {
    hvdc: kept(link, previous?.hvdc ?? null),
    northIsland: kept(island, previous?.northIsland ?? null),
    // Without a key, there are none: not the last there were.
    sites: key ? kept(sites, previous?.sites ?? null) : null,
  };

  const changed =
    newer(flow.hvdc, previous?.hvdc) ||
    newer(flow.northIsland, previous?.northIsland) ||
    newer(flow.sites, previous?.sites) ||
    // The key's gone.
    (!flow.sites && !!previous?.sites);

  return changed ? flow : null;
}
