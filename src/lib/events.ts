import { z } from "zod";
import { nzDate, nzTime } from "./nzClock";
import { readJson } from "./schemas";

// What's on at Wellington's big venues, for the scene to light them while it
// is: the stadium's floodlights on for a game, a theatre aglow through a
// show, each with an icon over it. Two sources, fetched once a day:
//
//   Eventfinda's API (https://www.eventfinda.co.nz/api/v2/index): concerts,
//   theatre, comedy and the like, by venue, each session with its start and
//   (mostly) its end. Wellington City Council's events calendar is built on
//   it. Basic auth, with a developer account's username and password in
//   EVENTFINDA_USERNAME and EVENTFINDA_PASSWORD.
//
//   TheSportsDB (https://www.thesportsdb.com/documentation): the Wellington
//   teams' fixtures, which Eventfinda mostly hasn't got. Its free key gives
//   a team's next match only (and a season's first 15, a day's first 3), so
//   it's asked each day: a home game is next once the match before it's
//   been played. Kick-offs only, in UTC; games run their sport's usual
//   length. SPORTSDB_KEY, if there's a paid key.

const EVENTFINDA = "https://api.eventfinda.co.nz/v2/events.json";
const SPORTSDB = "https://www.thesportsdb.com/api/v1/json";

/** TheSportsDB's shared free key, unless there's one of our own. */
const SPORTSDB_FREE_KEY = "123";

const TIMEOUT = 15_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Sessions from this long before the fetch to this long after are kept. */
const BEHIND = DAY;
const AHEAD = 8 * DAY;

/** Longer than this, it's an exhibition or a residency, not a show. */
const LONGEST = 12 * HOUR;

/** Eventfinda's page size. */
const ROWS = 20;

/** And the most pages read, in case it never says it's done. */
const PAGES = 10;

/**
 * The venues the scene lights, by key: their Eventfinda locations, and the
 * names TheSportsDB gives them (it renames them with their sponsors).
 */
const VENUES = {
  stadium: {
    name: "Hnry Stadium",
    eventfinda: [32926],
    fixtures: ["Hnry Stadium", "Sky Stadium", "Westpac Stadium"],
  },
  basin: {
    name: "Basin Reserve",
    eventfinda: [1810],
    fixtures: ["Basin Reserve"],
  },
  michaelFowler: { name: "Michael Fowler Centre", eventfinda: [912] },
  operaHouse: { name: "The Opera House", eventfinda: [911] },
  stJames: { name: "St James Theatre", eventfinda: [1292] },
  tsbArena: { name: "TSB Arena", eventfinda: [962] },
  shed6: { name: "Shed 6", eventfinda: [2105] },
  takina: { name: "Tākina", eventfinda: [39380] },
  townHall: { name: "Wellington Town Hall", eventfinda: [958] },
  tePapa: { name: "Te Papa", eventfinda: [1066, 14613, 30397, 30700] },
  hannah: { name: "Hannah Playhouse", eventfinda: [16079] },
  circa: { name: "Circa Theatre", eventfinda: [979] },
  bats: { name: "BATS Theatre", eventfinda: [1082] },
  embassy: { name: "Embassy Theatre", eventfinda: [1461] },
  stAndrews: { name: "St Andrew's on the Terrace", eventfinda: [948] },
  cathedral: { name: "Wellington Cathedral of St Paul", eventfinda: [1972] },
  oldStPauls: { name: "Old St Paul's", eventfinda: [4023] },
  sanFran: { name: "San Fran", eventfinda: [1041] },
  meow: { name: "Meow Nui", eventfinda: [41392] },
} satisfies Record<
  string,
  { name: string; eventfinda: number[]; fixtures?: string[] }
>;

export type VenueKey = keyof typeof VENUES;

// SAFETY: VENUES's own keys.
const venueKeys = Object.keys(VENUES) as [VenueKey, ...VenueKey[]];

/**
 * The Wellington teams whose home games light the stadium or the Basin: a
 * request each, of the free key's 30 a minute.
 */
const TEAMS = {
  /** Wellington Phoenix, A-League Men. */
  134475: "football",
  /** Wellington Phoenix, A-League Women. */
  144130: "football",
  /** Hurricanes, Super Rugby. */
  136665: "rugby",
  /** Wellington Firebirds, men's cricket. */
  144881: "cricket",
} satisfies Record<number, Kind>;

/** What sort of thing's on: the icon over the venue. */
export const kinds = [
  "rugby",
  "football",
  "cricket",
  "sport",
  "classical",
  "music",
  "theatre",
  "comedy",
  "film",
] as const;

export type Kind = (typeof kinds)[number];

/** How long one runs, when there's no end given. */
const LASTS: Record<Kind, number> = {
  // 80 minutes, half-time and stoppages.
  rugby: 2 * HOUR,
  football: 2 * HOUR,
  // A day's play; a T20's is shorter (see fixtureLength).
  cricket: 7 * HOUR,
  sport: 2.5 * HOUR,
  classical: 2.25 * HOUR,
  // Support act, headliner.
  music: 3 * HOUR,
  theatre: 2.5 * HOUR,
  comedy: 1.5 * HOUR,
  film: 2.5 * HOUR,
};

/** A T20's three and a half hours, two innings and the break. */
const T20 = 3.5 * HOUR;

export const venueEvent = z.object({
  venue: z.enum(venueKeys),
  name: z.string(),
  kind: z.enum(kinds),
  /** Epoch ms. */
  start: z.number(),
  end: z.number(),
  /** No end was given: it's the kind's usual length. */
  guessedEnd: z.boolean(),
});

export type VenueEvent = z.infer<typeof venueEvent>;

// Eventfinda's answer, less what isn't asked for.

const category = z.object({
  name: z.string(),
  parent_id: z.number().nullish(),
});

const session = z.object({
  /** NZ's wall clock: "2026-11-27 19:30:00". */
  datetime_start: z.string(),
  datetime_end: z.string().nullish(),
  is_cancelled: z.boolean().nullish(),
});

const listing = z.object({
  name: z.string(),
  is_cancelled: z.boolean().nullish(),
  location: z.object({ id: z.number() }),
  category,
  sessions: z.object({ sessions: z.array(session) }),
});

const listings = z.object({
  "@attributes": z.object({ count: z.number() }),
  events: z.array(listing),
});

/** Eventfinda's top-level categories, and some below them, by id. */
const PARENTS = new Map<number, Kind>([
  // Concerts & Gig Guide.
  [6, "music"],
  // Performing Arts; and under it Theatre, Dance, Musicals.
  [1, "theatre"],
  [21, "theatre"],
  [22, "theatre"],
  [23, "theatre"],
  // Sports & Outdoors.
  [7, "sport"],
]);

/** Categories whose names say what they are, first match. */
const NAMED: [RegExp, Kind][] = [
  [/classical|opera|choir|orchestra/i, "classical"],
  [/comedy/i, "comedy"],
  [/^film/i, "film"],
  [/rugby/i, "rugby"],
  [/soccer|football/i, "football"],
  [/cricket/i, "cricket"],
  [/family entertainment/i, "theatre"],
];

/**
 * What a listing in `name` (under `parent`) is, by Eventfinda's category;
 * null for what isn't a show or a game: talks, classes, markets,
 * exhibitions.
 */
export function kindOf({
  name,
  parent_id: parent,
}: z.infer<typeof category>): Kind | null {
  const named = NAMED.find(([pattern]) => pattern.test(name));

  if (named) return named[1];

  return (parent && PARENTS.get(parent)) || null;
}

const eventfindaVenue = new Map(
  Object.entries(VENUES).flatMap(([key, { eventfinda }]) =>
    // SAFETY: VENUES's own keys.
    eventfinda.map((id) => [id, key as VenueKey])
  )
);

/** Eventfinda's credentials, as a Basic auth header. */
function eventfindaAuth() {
  const user = process.env.EVENTFINDA_USERNAME;
  const password = process.env.EVENTFINDA_PASSWORD;

  if (!user || !password) throw new Error("eventfinda: no credentials");

  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

/** The shows at the venues with sessions between `from` and `to`. */
async function fetchListings(from: number, to: number): Promise<VenueEvent[]> {
  const headers = { Authorization: eventfindaAuth() };
  const found: VenueEvent[] = [];

  for (let page = 0; page < PAGES; page++) {
    const url = new URL(EVENTFINDA);

    url.search = new URLSearchParams({
      location: [...eventfindaVenue.keys()].join(","),
      start_date: nzDate(from),
      end_date: nzDate(to),
      rows: String(ROWS),
      offset: String(page * ROWS),
      fields: [
        "event:(name,is_cancelled,location,category,sessions)",
        "location:(id)",
        "category:(name,parent_id)",
        "session:(datetime_start,datetime_end,is_cancelled)",
      ].join(","),
    }).toString();

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!response.ok) throw new Error(`eventfinda: HTTP ${response.status}`);

    const body = await readJson(response, listings, "eventfinda");

    for (const event of body.events) {
      const venue = eventfindaVenue.get(event.location.id);
      const kind = kindOf(event.category);

      if (!venue || !kind || event.is_cancelled) continue;

      for (const { datetime_start, datetime_end, is_cancelled } of event
        .sessions.sessions) {
        if (is_cancelled) continue;

        const start = nzTime(datetime_start);

        // Eventfinda gives an end of 23:59:59 when it hasn't got one.
        const given =
          datetime_end && !datetime_end.endsWith("23:59:59")
            ? nzTime(datetime_end)
            : null;

        const guessedEnd = given === null || given <= start;
        const end = guessedEnd ? start + LASTS[kind] : given;

        if (end - start > LONGEST || end < from || start > to) continue;

        found.push({
          venue,
          name: event.name,
          kind,
          start,
          end,
          guessedEnd,
        });
      }
    }

    if ((page + 1) * ROWS >= body["@attributes"].count) break;
  }

  return found;
}

const fixture = z.object({
  strEvent: z.string(),
  strLeague: z.string().nullish(),
  /** UTC, without a zone: "2026-12-06T02:00:00". */
  strTimestamp: z.string().nullish(),
  strVenue: z.string().nullish(),
  strStatus: z.string().nullish(),
});

const fixtures = z.object({ events: z.array(fixture).nullable() });

/** How long a game of `kind` in `league` lasts. */
const fixtureLength = (kind: Kind, league: string) =>
  kind === "cricket" && /smash|t20/i.test(league) ? T20 : LASTS[kind];

const fixtureVenue = (name: string) =>
  // SAFETY: VENUES's own entries.
  (Object.entries(VENUES) as [VenueKey, { fixtures?: string[] }][]).find(
    ([, { fixtures }]) => fixtures?.some((known) => name.includes(known))
  )?.[0];

/** The Wellington teams' next games, those at the venues. */
async function fetchFixtures(from: number, to: number): Promise<VenueEvent[]> {
  const key = process.env.SPORTSDB_KEY || SPORTSDB_FREE_KEY;
  const found: VenueEvent[] = [];

  for (const [team, kind] of Object.entries(TEAMS)) {
    const response = await fetch(
      `${SPORTSDB}/${key}/eventsnext.php?id=${team}`,
      {
        signal: AbortSignal.timeout(TIMEOUT),
      }
    );

    if (!response.ok) throw new Error(`thesportsdb: HTTP ${response.status}`);

    const { events } = await readJson(response, fixtures, "thesportsdb");

    for (const game of events ?? []) {
      const venue = game.strVenue && fixtureVenue(game.strVenue);

      if (!venue || !game.strTimestamp) continue;

      if (/postponed|cancel/i.test(game.strStatus ?? "")) continue;

      const start = Date.parse(`${game.strTimestamp}Z`);

      if (Number.isNaN(start) || start > to) continue;

      const end = start + fixtureLength(kind, game.strLeague ?? "");

      if (end < from) continue;

      found.push({
        venue,
        name: game.strEvent,
        kind,
        start,
        end,
        guessedEnd: true,
      });
    }
  }

  return found;
}

const isSport = (kind: Kind) =>
  kind === "rugby" ||
  kind === "football" ||
  kind === "cricket" ||
  kind === "sport";

/**
 * What's on at the venues from a day before `now` to a week or so after,
 * by start. The fixtures' games stand in for a listing of the same game:
 * a sports listing at the same venue within a few hours of one.
 */
export async function fetchEvents(now = Date.now()): Promise<VenueEvent[]> {
  const from = now - BEHIND;
  const to = now + AHEAD;

  const [listed, games] = await Promise.all([
    fetchListings(from, to),
    fetchFixtures(from, to),
  ]);

  const duplicate = (event: VenueEvent) =>
    isSport(event.kind) &&
    games.some(
      (game) =>
        game.venue === event.venue &&
        Math.abs(game.start - event.start) < 4 * HOUR
    );

  const seen = new Set<string>();

  return [...games, ...listed.filter((event) => !duplicate(event))]
    .filter(({ venue, name, start }) => {
      // Eventfinda lists some shows twice.
      const key = `${venue}|${name}|${start}`;

      if (seen.has(key)) return false;
      seen.add(key);

      return true;
    })
    .sort((a, b) => a.start - b.start);
}
