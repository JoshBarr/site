import { z } from "zod";
import { nzTime } from "./nzClock";
import { toNztm } from "./nztm";
import { point, readJson } from "./schemas";

// Wellington's birds, as birders count them: eBird's checklists
// (https://documenter.getpostman.com/view/664302/S1ENwy59), for the scene to
// put its flocks where they're seen, as many as were counted. Not where
// birds are now: a checklist's sent in hours or days after the walk, so it
// says where the roosts and feeding grounds are, and how big the flocks on
// them run. Key in EBIRD_API_KEY; 500 requests an hour, 25 in 5 s.
//
// Three things about the API, found by asking (plans/birds.md):
//
//   Its "recent observations" calls give one record per species, however
//   many birders saw it, so they can't say where the flocks are. Whole
//   checklists can: the region's newest (or a day's), then each one's.
//
//   The region, NZ-WGN, runs to the Wairarapa: a quarter of its checklists
//   are off the map.
//
//   Birders out together each send in the same checklist, under one
//   groupId: kept once.

const EBIRD = "https://api.ebird.org/v2";

/** eBird's code for the Wellington region. */
const REGION = "NZ-WGN";

const TIMEOUT = 15_000;

/** The most checklists a list call gives: about a week's, in the region. */
const LISTED = 200;

/**
 * The terrain root the scene covers, NZTM [west, south, east, north]
 * (as ./trains.ts's): checklists beyond it aren't kept.
 */
const MAP_BOUNDS = [1715232, 5395232, 1780768, 5460768];

const [WEST, SOUTH, EAST, NORTH] = MAP_BOUNDS;

/** eBird's protocols, by id; the rest are "other". */
const PROTOCOLS = {
  P20: "incidental",
  P21: "stationary",
  P22: "traveling",
  P23: "area",
  P60: "pelagic",
  P62: "historical",
} as const;

const protocols = [...Object.values(PROTOCOLS), "other"] as const;

const protocolOf = new Map<string, (typeof protocols)[number]>(
  Object.entries(PROTOCOLS)
);

const birdChecklist = z.object({
  /** eBird's submission id, of the copy kept if a group sent in several. */
  id: z.string(),
  /** The birders' group, if they were out together. */
  group: z.string().nullable(),
  /** When it started, epoch ms; midday if the birder gave no time. */
  at: z.number(),
  timed: z.boolean(),
  /** How long they looked, and how far they went, if they said. */
  minutes: z.number().nullable(),
  km: z.number().nullable(),
  protocol: z.enum(protocols),
  /**
   * Where, NZTM: a hotspot's own point, or someone's own spot to ~100 m (it
   * may be their garden).
   */
  position: point,
  /** The hotspot's id and name; null at someone's own spot. */
  site: z.string().nullable(),
  place: z.string().nullable(),
  /** Each species' code and how many were counted; null if just "present". */
  birds: z.array(z.tuple([z.string(), z.number().nullable()])),
});

type BirdChecklist = z.infer<typeof birdChecklist>;

const birdSpecies = z.object({
  name: z.string(),
  sci: z.string(),
  /** eBird's family code ("larida1", gulls and terns); null for a "gull sp." */
  family: z.string().nullable(),
});

/** One fetch's worth: the new checklists, and what their species are. */
export const birdSightings = z.object({
  checklists: z.array(birdChecklist),
  /** Every submission read, kept or not, so it isn't read again. */
  checked: z.array(z.string()),
  species: z.record(z.string(), birdSpecies),
});

export type BirdSightings = z.infer<typeof birdSightings>;

/** What's been stored already, to leave out. */
export interface Seen {
  ids: Set<string>;
  groups: Set<string>;
}

// eBird's answers, less what isn't asked for.

const listed = z.array(
  z.object({
    subId: z.string(),
    numSpecies: z.number(),
    loc: z.object({
      locId: z.string(),
      name: z.string(),
      lat: z.number(),
      lng: z.number(),
      isHotspot: z.boolean(),
    }),
  })
);

export type Listed = z.infer<typeof listed>[number];

const checklist = z.object({
  subId: z.string(),
  groupId: z.string().nullish(),
  protocolId: z.string(),
  durationHrs: z.number().nullish(),
  effortDistanceKm: z.number().nullish(),
  /** NZ's wall clock: "2026-11-18 18:14". */
  obsDt: z.string(),
  obsTimeValid: z.boolean().nullish(),
  obs: z.array(
    z.object({
      speciesCode: z.string(),
      howManyAtleast: z.number().nullish(),
    })
  ),
});

const taxonomy = z.array(
  z.object({
    speciesCode: z.string(),
    comName: z.string(),
    sciName: z.string(),
    familyCode: z.string().nullish(),
  })
);

function ebirdKey() {
  const key = process.env.EBIRD_API_KEY;

  if (!key) throw new Error("ebird: no key");

  return key;
}

async function ebird<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(`${EBIRD}${path}`, {
    headers: { "x-ebirdapitoken": ebirdKey() },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`ebird: HTTP ${response.status}`);

  return readJson(response, schema, "ebird");
}

/**
 * The region's newest checklists; or, given an NZ date ("2026-11-20"),
 * that day's.
 */
export function listChecklists(date?: string) {
  const day = date ? `/${date.replaceAll("-", "/")}` : "";

  return ebird(`/product/lists/${REGION}${day}?maxResults=${LISTED}`, listed);
}

/** Where a listed checklist was, NZTM, if it's on the map. */
function placed({ loc }: Listed): [number, number] | null {
  // Someone's own spot's kept to ~100 m.
  const round = (degrees: number) =>
    loc.isHotspot ? degrees : Math.round(degrees * 1000) / 1000;

  const [easting, northing] = toNztm(round(loc.lat), round(loc.lng));

  const on =
    easting >= WEST &&
    easting <= EAST &&
    northing >= SOUTH &&
    northing <= NORTH;

  return on ? [easting, northing] : null;
}

const minutes = (hours: number | null | undefined) =>
  hours == null ? null : Math.round(hours * 60);

/**
 * The checklists in `list` that are on the map, have birds on them and
 * aren't `seen`, read from eBird, the most `limit`, oldest first (the rest
 * are left for next time); a group's sent in once. Null if there were none
 * to read. Calls `pause` before each request, to keep under eBird's limits.
 * Throws if none of them could be read.
 */
export async function fetchBirds(
  list: Listed[],
  seen: Seen,
  {
    limit = Infinity,
    pause = async () => {},
  }: { limit?: number; pause?: () => Promise<void> } = {}
): Promise<BirdSightings | null> {
  const toRead = list
    .flatMap((entry) => {
      const position =
        entry.numSpecies > 0 && !seen.ids.has(entry.subId)
          ? placed(entry)
          : null;

      return position ? [{ entry, position }] : [];
    })
    .reverse()
    .slice(0, limit);

  if (toRead.length === 0) return null;

  const checklists: BirdChecklist[] = [];
  const checked: string[] = [];
  const groups = new Set(seen.groups);
  let failed: unknown;

  for (const { entry, position } of toRead) {
    await pause();

    let read: z.infer<typeof checklist>;

    try {
      read = await ebird(`/product/checklist/view/${entry.subId}`, checklist);
    } catch (error) {
      // Left unread, for next time.
      failed ??= error;
      continue;
    }

    checked.push(entry.subId);

    const group = read.groupId || null;

    if (group && groups.has(group)) continue;

    if (group) groups.add(group);

    const timed = read.obsTimeValid !== false && read.obsDt.includes(" ");
    const day = read.obsDt.slice(0, 10);

    checklists.push({
      id: read.subId,
      group,
      at: nzTime(timed ? read.obsDt : `${day} 12:00`),
      timed,
      minutes: minutes(read.durationHrs),
      km: read.effortDistanceKm ?? null,
      protocol: protocolOf.get(read.protocolId) ?? "other",
      position,
      site: entry.loc.isHotspot ? entry.loc.locId : null,
      place: entry.loc.isHotspot ? entry.loc.name : null,
      birds: read.obs.map((o) => [o.speciesCode, o.howManyAtleast ?? null]),
    });
  }

  if (checked.length === 0) throw failed;

  return {
    checklists,
    checked,
    species: await speciesOf(checklists, pause),
  };
}

/** The names of the species on `checklists`, by code: one request. */
async function speciesOf(
  checklists: BirdChecklist[],
  pause: () => Promise<void>
) {
  const codes = [
    ...new Set(checklists.flatMap((c) => c.birds.map(([code]) => code))),
  ].sort();

  if (codes.length === 0) return {};

  await pause();

  const taxa = await ebird(
    `/ref/taxonomy/ebird?fmt=json&species=${codes.join(",")}`,
    taxonomy
  );

  return Object.fromEntries(
    taxa.map((t) => [
      t.speciesCode,
      { name: t.comName, sci: t.sciName, family: t.familyCode ?? null },
    ])
  );
}

/** How many birds `sightings` counted, those just seen as present aside. */
export const counted = (sightings: BirdSightings) =>
  sightings.checklists
    .flatMap((c) => c.birds)
    .reduce((sum, [, count]) => sum + (count ?? 0), 0);

/** What `stored` holds: every submission read, and every group kept. */
export function seenIn(stored: BirdSightings[]): Seen {
  return {
    ids: new Set(stored.flatMap((s) => s.checked)),
    groups: new Set(
      stored.flatMap((s) =>
        s.checklists.flatMap((c) => (c.group ? [c.group] : []))
      )
    ),
  };
}
