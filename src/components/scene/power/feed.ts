import type { SiteCode } from "../../../lib/gridFlow";
import type { Span, Structure } from "./grid";
import { HVDC_KV } from "./towers";

// Whose load each tower and span is lit by, when the grid's lit (see
// energise.ts and flow.ts): the nearer a substation is along the lines, the
// more it's that one's. The lines really carry every substation's power
// past them on to the next, but there's no telling how much from what's
// published; this is a picture of where the load is, not of the flows.

/**
 * A grid exit point on the map, or a wind farm's: where it is (Transpower's
 * open data, CC BY 4.0), and the megawatts it's taken to be working flat
 * out at. For a wind farm that's what it can send out. For the rest it's
 * about the winter peak its load reaches, and those are from memory of
 * Transpower's planning reports, not looked up: near enough for how bright
 * a line is, and worth checking against a winter of readings.
 */
export interface Substation {
  code: SiteCode;
  easting: number;
  northing: number;
  most: number;
  /** A wind farm: it's the megawatts sent out that count. */
  sends?: boolean;
}

export const SUBSTATIONS: Substation[] = [
  { code: "CPK", easting: 1748149, northing: 5426363, most: 190 },
  { code: "GFD", easting: 1760647, northing: 5432797, most: 60 },
  { code: "HAY", easting: 1766258, northing: 5442603, most: 40 },
  // Its 110 kV comes in under the ground from a gantry up the gorge.
  { code: "KWA", easting: 1750000, northing: 5430943, most: 45 },
  { code: "MLG", easting: 1760654, northing: 5437236, most: 75 },
  { code: "PNI", easting: 1761116, northing: 5447292, most: 22 },
  { code: "TKR", easting: 1757034, northing: 5442090, most: 97 },
  { code: "UHT", easting: 1775872, northing: 5448080, most: 33 },
  { code: "WIL", easting: 1747404, northing: 5431048, most: 55 },
  // West Wind: 62 turbines of 2.3 MW.
  {
    code: "WWD",
    easting: 1740613.8,
    northing: 5429842.1,
    most: 142.6,
    sends: true,
  },
];

/** Haywards' converter station, the HVDC link's northern end: NZTM. */
export const HAYWARDS: [easting: number, northing: number] = [1766284, 5442555];

/** A line's gantries this near a substation's point are its own, m. */
const NEAR = 450;

/**
 * A substation's share of a tower falls off as the square of how far along
 * the lines it is, taken to be at least this far, m: so one's own lines
 * are all its own for a kilometre or so, and half and half midway to the
 * next.
 */
const AT_LEAST = 150;

export interface Feeding {
  /** How many substations there are shares for. */
  sites: number;
  /**
   * A row to a structure, `sites` long: each substation's share of it,
   * adding up to 1. All zero on the HVDC link.
   */
  shares: Float32Array;
  /** 1 for each structure on the HVDC link. */
  link: Uint8Array;
}

/** How far each structure is from `sources` along the AC spans, m. */
function alongLines(
  structures: Structure[],
  ways: [to: number, length: number][][],
  sources: number[]
) {
  const far = new Float64Array(structures.length).fill(Infinity);
  const done = new Uint8Array(structures.length);

  for (const source of sources) far[source] = 0;

  // A few hundred structures: the nearest not yet settled is just looked for.
  for (;;) {
    let next = -1;

    for (let i = 0; i < far.length; i++) {
      if (!done[i] && far[i] < (next < 0 ? Infinity : far[next])) next = i;
    }

    if (next < 0) return far;
    done[next] = 1;

    for (const [to, length] of ways[next]) {
      far[to] = Math.min(far[to], far[next] + length);
    }
  }
}

/** Each substation's share of every structure, by how far off it is. */
export function feeding(
  structures: Structure[],
  spans: Span[],
  substations: Pick<Substation, "easting" | "northing">[]
): Feeding {
  const link = Uint8Array.from(structures, ([, , , , , kv]) =>
    kv >= HVDC_KV ? 1 : 0
  );

  const ways: [number, number][][] = structures.map(() => []);

  for (const [a, b] of spans) {
    if (link[a] || link[b]) continue;

    const length = Math.hypot(
      structures[a][0] - structures[b][0],
      structures[a][1] - structures[b][1]
    );

    ways[a].push([b, length]);
    ways[b].push([a, length]);
  }

  const far = substations.map(({ easting, northing }) =>
    alongLines(
      structures,
      ways,
      structures.flatMap(([e, n, , , type], i) =>
        type === "X" && !link[i] && Math.hypot(e - easting, n - northing) < NEAR
          ? [i]
          : []
      )
    )
  );

  const sites = substations.length;
  const shares = new Float32Array(structures.length * sites);

  structures.forEach((_, i) => {
    if (link[i]) return;

    const pulls = far.map((distances) => (distances[i] + AT_LEAST) ** -2);
    const all = pulls.reduce((sum, pull) => sum + pull, 0);

    // Strung to none of them (a line passing through): all alike.
    pulls.forEach((pull, site) => {
      shares[i * sites + site] = all > 0 ? pull / all : 1 / sites;
    });
  });

  return { sites, shares, link };
}

/**
 * How hard each structure's lines are working, given how hard each
 * substation is (`levels`, in their order): its substations', by their
 * shares of it. Nothing's said of the HVDC link's, which are 0.
 */
export function levelsOf({ sites, shares }: Feeding, levels: number[]) {
  const structures = shares.length / sites;
  const worked = new Float32Array(structures);

  for (let i = 0; i < structures; i++) {
    let level = 0;

    for (let site = 0; site < sites; site++) {
      level += shares[i * sites + site] * levels[site];
    }

    worked[i] = level;
  }

  return worked;
}
