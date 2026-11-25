import { z } from "zod";
import type { BirdSightings } from "./birds";
import { point } from "./schemas";

// Where Wellington's flocks gather, as birders' checklists (./birds.ts) have
// it: for the scene to fly its simulated flocks from. Each fetch of
// checklists is summed up into sites: for each kind of bird, each
// kilometre square it's been counted in, how many usually are, how surely
// they're there and when they were last seen. A sighting counts for half
// as much each week it gets older, and not at all after a month.

const DAY = 86_400_000;

/** How long it takes a sighting to count for half as much. */
const HALF_LIFE = 7 * DAY;

/** And how long it counts at all: as long as checklists are kept. */
const WINDOW = 30 * DAY;

/** Sites are gathered in squares this big, metres. */
const CELL = 1000;

/** A site counted for less than this (one sighting a month ago) is left. */
const LEAST = 0.06;

/** A site's spread, metres: at least, and at most. */
const SPREAD = [100, 3000] as const;

/**
 * The kinds of bird the scene flies, as they behave: rafts of shearwaters,
 * gulls wheeling on the coast, starlings' murmurations, songbirds flitting
 * through the trees. "ground" is birds that don't fly (kiwi, takahē,
 * quail, penguins).
 */
const birdKinds = [
  "shearwater",
  "albatross",
  "gull",
  "tern",
  "shag",
  "gannet",
  "waterfowl",
  "wader",
  "pigeon",
  "parrot",
  "starling",
  "finch",
  "songbird",
  "raptor",
  "ground",
  "other",
] as const;

type BirdKind = (typeof birdKinds)[number];

/** eBird's families (BirdSpecies.family), by the kind they fly as. */
const FAMILIES: Record<Exclude<BirdKind, "tern" | "other">, string[]> = {
  // Shearwaters, petrels, prions.
  shearwater: ["procel3", "hydrob1", "oceani1"],
  albatross: ["diomed1"],
  // Gulls and terns, and skuas, which follow them.
  gull: ["larida1", "sterco1"],
  // Shags and the darter.
  shag: ["phalac1", "anhing3"],
  gannet: ["sulida1"],
  // Ducks, geese, swans; and grebes.
  waterfowl: ["anatid1", "podici1"],
  // Oystercatchers, stilts, plovers, godwits, herons, spoonbills.
  wader: ["haemat1", "recurv1", "charad1", "scolop2", "ardeid1", "thresk1"],
  pigeon: ["columb2"],
  // Kākā, kākāriki, rosellas.
  parrot: ["strigo1", "psitta4", "psitta1", "cacatu1"],
  starling: ["sturni1"],
  // Small birds in flocks: sparrows, finches, silvereyes, swallows, larks.
  finch: [
    "passer4",
    "fringi1",
    "emberi2",
    "zoster2",
    "hirund2",
    "alaudi1",
    "motaci1",
  ],
  // Perching birds mostly alone or in pairs: tūī, bellbirds, blackbirds,
  // fantails, warblers, robins, kingfishers, magpies, cuckoos.
  songbird: [
    "meliph3",
    "turdid1",
    "rhipid1",
    "acanth2",
    "mohoui1",
    "callae1",
    "petroi2",
    "notiom1",
    "cuculi1",
    "acanth1",
    "prunel1",
    "alcedi1",
    "artami1",
    "corvid1",
  ],
  // Falcons, harriers, the morepork.
  raptor: ["falcon1", "accipi1", "strigi1"],
  ground: ["aptery1", "rallid1", "odonto1", "phasia1", "spheni1"],
};

const kindOfFamily = new Map<string, BirdKind>(
  Object.entries(FAMILIES).flatMap(([kind, families]) =>
    // SAFETY: FAMILIES's own keys are kinds.
    families.map((family) => [family, kind as BirdKind])
  )
);

/** Terns, among the gulls' family, by genus. */
const TERNS = new Set([
  "Sterna",
  "Sternula",
  "Hydroprogne",
  "Chlidonias",
  "Thalasseus",
  "Onychoprion",
  "Gelochelidon",
  "Anous",
  "Gygis",
]);

/** The kind a species flies as, by its family (and a tern by its genus). */
export function kindOf(species: { sci: string; family: string | null }) {
  const kind = (species.family && kindOfFamily.get(species.family)) || "other";

  return kind === "gull" && TERNS.has(species.sci.split(" ")[0])
    ? "tern"
    : kind;
}

const flockSite = z.object({
  kind: z.enum(birdKinds),
  /** The species counted there, most first: up to three codes. */
  species: z.array(z.string()),
  /** Where they gather, NZTM, to the metre. */
  position: point,
  /** How far about it they're seen, metres. */
  radius: z.number(),
  /** How many are usually counted together, recent counts first. */
  size: z.number(),
  /** The most counted together. */
  peak: z.number(),
  /**
   * How surely they're there: each checklist counts 1 when it's new, half
   * a week on. Over 1, they're seen most visits.
   */
  weight: z.number(),
  /** Checklists that counted them, in the month. */
  seen: z.number(),
  /** When last counted, epoch ms. */
  last: z.number(),
});

export type FlockSite = z.infer<typeof flockSite>;

export const flockSummary = z.object({
  sites: z.array(flockSite),
  /** The species' names, by code. */
  species: z.record(
    z.string(),
    z.object({ name: z.string(), sci: z.string(), kind: z.enum(birdKinds) })
  ),
});

export type FlockSummary = z.infer<typeof flockSummary>;

interface Gathering {
  kind: BirdKind;
  weight: number;
  /** Σ weight × count. */
  counted: number;
  /** Σ weight × easting, northing, and their squares, for the spread. */
  e: number;
  n: number;
  e2: number;
  n2: number;
  /** Σ weight × how far the birder walked about, metres. */
  walked: number;
  peak: number;
  seen: number;
  last: number;
  bySpecies: Map<string, number>;
}

const round = (value: number, places = 0) =>
  Math.round(value * 10 ** places) / 10 ** places;

/** A gathering's site: its middle, spread, usual count and species. */
function toSite(g: Gathering): FlockSite {
  const e = g.e / g.weight;
  const n = g.n / g.weight;

  // How far the checklists are from their middle, and how far about
  // the birders walked.
  const scatter = Math.sqrt(
    Math.max(0, g.e2 / g.weight - e ** 2 + g.n2 / g.weight - n ** 2)
  );

  const radius = Math.min(
    Math.max(scatter + g.walked / g.weight, SPREAD[0]),
    SPREAD[1]
  );

  return {
    kind: g.kind,
    species: [...g.bySpecies]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([code]) => code),
    position: [Math.round(e), Math.round(n)],
    radius: Math.round(radius),
    size: Math.max(1, Math.round(g.counted / g.weight)),
    peak: g.peak,
    weight: round(g.weight, 2),
    seen: g.seen,
    last: g.last,
  };
}

/** The flocks the checklists stored by `at` (epoch ms) say gather. */
export function summarise(stored: BirdSightings[], at: number): FlockSummary {
  const names: BirdSightings["species"] = Object.assign(
    {},
    ...stored.map((s) => s.species)
  );

  const gatherings = new Map<string, Gathering>();

  for (const checklist of stored.flatMap((s) => s.checklists)) {
    const age = at - checklist.at;

    if (age < 0 || age > WINDOW) continue;

    const weight = 0.5 ** (age / HALF_LIFE);
    const [easting, northing] = checklist.position;
    // A walk's birds were seen along it: about half its length either way.
    const walked = Math.min(((checklist.km ?? 0) * 1000) / 2, SPREAD[1]);

    // The checklist's birds by kind: those just seen as present count one.
    const byKind = new Map<BirdKind, Map<string, number>>();

    for (const [code, count] of checklist.birds) {
      const species = names[code];
      const kind = species ? kindOf(species) : "other";
      const counts = byKind.get(kind) ?? new Map<string, number>();

      counts.set(code, (counts.get(code) ?? 0) + (count ?? 1));
      byKind.set(kind, counts);
    }

    for (const [kind, counts] of byKind) {
      const cell = `${kind}:${Math.floor(easting / CELL)}:${Math.floor(northing / CELL)}`;
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

      const g = gatherings.get(cell) ?? {
        kind,
        weight: 0,
        counted: 0,
        e: 0,
        n: 0,
        e2: 0,
        n2: 0,
        walked: 0,
        peak: 0,
        seen: 0,
        last: 0,
        bySpecies: new Map<string, number>(),
      };

      g.weight += weight;
      g.counted += weight * total;
      g.e += weight * easting;
      g.n += weight * northing;
      g.e2 += weight * easting ** 2;
      g.n2 += weight * northing ** 2;
      g.walked += weight * walked;
      g.peak = Math.max(g.peak, total);
      g.seen += 1;
      g.last = Math.max(g.last, checklist.at);

      for (const [code, n] of counts) {
        g.bySpecies.set(code, (g.bySpecies.get(code) ?? 0) + weight * n);
      }

      gatherings.set(cell, g);
    }
  }

  const sites = [...gatherings.values()]
    .flatMap((g) => (g.weight >= LEAST ? [toSite(g)] : []))
    .sort((a, b) => b.weight * b.size - a.weight * a.size);

  const codes = new Set(sites.flatMap((s) => s.species));

  return {
    sites,
    species: Object.fromEntries(
      [...codes].flatMap((code) => {
        const species = names[code];

        return species
          ? [
              [
                code,
                { name: species.name, sci: species.sci, kind: kindOf(species) },
              ],
            ]
          : [];
      })
    ),
  };
}
