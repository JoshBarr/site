import { http, HttpResponse } from "msw/http";
import { server } from "../msw";

// Eventfinda's event listings and TheSportsDB's fixtures, as they answer.

type Session = {
  datetime_start: string;
  datetime_end?: string | null;
  is_cancelled?: boolean;
};

/** An Eventfinda listing at location `venue`, as its API gives one. */
export const listing = (
  name: string,
  venue: number,
  category: { name: string; parent_id: number | null },
  sessions: Session[],
  extra: { is_cancelled?: boolean } = {}
) => ({
  name,
  is_cancelled: false,
  location: { id: venue },
  category,
  sessions: { "@attributes": { count: sessions.length }, sessions },
  ...extra,
});

/** Aldous Harding at the Michael Fowler Centre: no end given. */
export const ALDOUS = listing(
  "Aldous Harding",
  912,
  { name: "Pop", parent_id: 6 },
  [
    {
      datetime_start: "2026-11-02 20:00:00",
      datetime_end: "2026-11-02 23:59:59",
    },
  ]
);

/** The NZSO's Messiah, at the same: it ends when it says. */
export const MESSIAH = listing(
  "NZSO Messiah",
  912,
  { name: "Classical Music", parent_id: 1 },
  [
    {
      datetime_start: "2026-11-03 19:30:00",
      datetime_end: "2026-11-03 21:50:00",
    },
  ]
);

/** A pantomime at Circa, two nights, the second cancelled. */
export const PANTO = listing(
  "Beauty and the Beast - The Pantomime",
  979,
  { name: "Theatre", parent_id: 1 },
  [
    {
      datetime_start: "2026-11-01 18:30:00",
      datetime_end: "2026-11-01 20:30:00",
    },
    {
      datetime_start: "2026-11-04 18:30:00",
      datetime_end: "2026-11-04 20:30:00",
      is_cancelled: true,
    },
  ]
);

/** An exhibition at Te Papa: months long, not a show. */
export const EXHIBITION = listing(
  "Toi Art",
  1066,
  { name: "Contemporary Art", parent_id: 11 },
  [
    {
      datetime_start: "2026-09-01 10:00:00",
      datetime_end: "2026-12-24 18:00:00",
    },
  ]
);

/** The Phoenix at the stadium, as Eventfinda lists it (from 3 pm NZDT). */
export const PHOENIX_LISTED = listing(
  "Wellington Phoenix v Adelaide United",
  32926,
  { name: "Soccer", parent_id: 7 },
  [{ datetime_start: "2026-11-03 15:00:00", datetime_end: null }]
);

/**
 * Eventfinda answering with `events`, `rows` a page, recording each request
 * and the Authorization it came with. Or failing with `status`.
 */
export function eventfinda(events: unknown[], status = 200) {
  const requests: { url: URL; auth: string | null }[] = [];

  server.use(
    http.get("https://api.eventfinda.co.nz/v2/events.json", ({ request }) => {
      const url = new URL(request.url);

      requests.push({ url, auth: request.headers.get("Authorization") });

      if (status !== 200) return new HttpResponse(null, { status });

      const rows = Number(url.searchParams.get("rows"));
      const offset = Number(url.searchParams.get("offset"));

      return HttpResponse.json({
        "@attributes": { count: events.length },
        events: events.slice(offset, offset + rows),
      });
    })
  );

  return { requests };
}

/** A TheSportsDB fixture, as eventsnext.php gives one. */
const fixture = (
  strEvent: string,
  strTimestamp: string,
  strVenue: string,
  strLeague = "Australian A-League"
) => ({
  idEvent: "2627864",
  strEvent,
  strLeague,
  strSport: "Soccer",
  strTimestamp,
  dateEvent: strTimestamp.slice(0, 10),
  strVenue,
  strStatus: "NS",
});

/** The Phoenix's next game, at home: 3 pm NZDT, 2 am UTC. */
export const PHOENIX = fixture(
  "Wellington Phoenix vs Adelaide United",
  "2026-11-03T02:00:00",
  "Hnry Stadium"
);

/** The Firebirds' next, a T20 at the Basin: 4:15 pm NZDT. */
export const FIREBIRDS = fixture(
  "Wellington Firebirds vs Otago Volts",
  "2026-11-04T03:15:00",
  "Cello Basin Reserve",
  "New Zealand Super Smash"
);

/** The Hurricanes', away. */
export const HURRICANES_AWAY = fixture(
  "Blues Super Rugby vs Hurricanes Super Rugby",
  "2026-11-05T06:05:00",
  "Eden Park",
  "Super Rugby"
);

/**
 * TheSportsDB answering each team's next games from `next` (by team id;
 * none for the rest), recording the requests. Or failing with `status`.
 */
export function sportsdb(next: Record<string, unknown[]>, status = 200) {
  const requests: URL[] = [];

  server.use(
    http.get(
      "https://www.thesportsdb.com/api/v1/json/:key/eventsnext.php",
      ({ request }) => {
        const url = new URL(request.url);

        requests.push(url);

        if (status !== 200) return new HttpResponse(null, { status });

        return HttpResponse.json({
          events: next[url.searchParams.get("id") ?? ""] ?? null,
        });
      }
    )
  );

  return { requests };
}
