import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEvents, kindOf } from "../../src/lib/events";
import { freezeTime } from "../clock";
import {
  ALDOUS,
  EXHIBITION,
  eventfinda,
  FIREBIRDS,
  HURRICANES_AWAY,
  listing,
  MESSIAH,
  PANTO,
  PHOENIX,
  PHOENIX_LISTED,
  sportsdb,
} from "../fixtures/events";

// What's on at the big venues: Eventfinda's listings and the Wellington
// teams' fixtures. NOW is 8 pm NZDT on the 2nd of November.

describe("what's on at the venues", () => {
  beforeEach(() => {
    freezeTime();
    vi.stubEnv("EVENTFINDA_USERNAME", "josh");
    vi.stubEnv("EVENTFINDA_PASSWORD", "secret");
  });

  it("is each show's sessions and each home game, by start", async () => {
    eventfinda([ALDOUS, MESSIAH, PANTO, EXHIBITION, PHOENIX_LISTED]);
    sportsdb({
      134475: [PHOENIX],
      144881: [FIREBIRDS],
      136665: [HURRICANES_AWAY],
    });

    expect(await fetchEvents()).toEqual([
      {
        venue: "circa",
        name: "Beauty and the Beast - The Pantomime",
        kind: "theatre",
        start: Date.parse("2026-11-01T05:30Z"),
        end: Date.parse("2026-11-01T07:30Z"),
        guessedEnd: false,
      },
      {
        venue: "michaelFowler",
        name: "Aldous Harding",
        kind: "music",
        start: Date.parse("2026-11-02T07:00Z"),
        // Eventfinda's 23:59:59 is no end: a gig's three hours.
        end: Date.parse("2026-11-02T10:00Z"),
        guessedEnd: true,
      },
      {
        // TheSportsDB's, not Eventfinda's listing of the same game.
        venue: "stadium",
        name: "Wellington Phoenix vs Adelaide United",
        kind: "football",
        start: Date.parse("2026-11-03T02:00Z"),
        end: Date.parse("2026-11-03T04:00Z"),
        guessedEnd: true,
      },
      {
        venue: "michaelFowler",
        name: "NZSO Messiah",
        kind: "classical",
        start: Date.parse("2026-11-03T06:30Z"),
        end: Date.parse("2026-11-03T08:50Z"),
        guessedEnd: false,
      },
      {
        venue: "basin",
        name: "Wellington Firebirds vs Otago Volts",
        kind: "cricket",
        start: Date.parse("2026-11-04T03:15Z"),
        // A T20.
        end: Date.parse("2026-11-04T06:45Z"),
        guessedEnd: true,
      },
    ]);
  });

  it("asks Eventfinda for the venues' week, with its credentials", async () => {
    const { requests } = eventfinda([]);
    sportsdb({});

    await fetchEvents();

    expect(requests).toHaveLength(1);
    const [{ url, auth }] = requests;
    expect(auth).toBe(`Basic ${btoa("josh:secret")}`);
    expect(url.searchParams.get("location")?.split(",")).toContain("912");
    expect(url.searchParams.get("start_date")).toBe("2026-11-01");
    expect(url.searchParams.get("end_date")).toBe("2026-11-10");
  });

  it("reads every page", async () => {
    const shows = Array.from({ length: 45 }, (_, i) =>
      listing(`Show ${i}`, 1082, { name: "Theatre", parent_id: 1 }, [
        { datetime_start: "2026-11-03 19:00:00", datetime_end: null },
      ])
    );

    const { requests } = eventfinda(shows);
    sportsdb({});

    const events = await fetchEvents();

    expect(requests.map(({ url }) => url.searchParams.get("offset"))).toEqual([
      "0",
      "20",
      "40",
    ]);
    expect(events).toHaveLength(45);
  });

  it("drops what's on outside the week, or cancelled", async () => {
    eventfinda([
      listing("Long gone", 911, { name: "Pop", parent_id: 6 }, [
        { datetime_start: "2026-10-20 19:00:00" },
      ]),
      listing(
        "Called off",
        911,
        { name: "Pop", parent_id: 6 },
        [{ datetime_start: "2026-11-03 19:00:00" }],
        { is_cancelled: true }
      ),
    ]);
    sportsdb({});

    expect(await fetchEvents()).toEqual([]);
  });

  it("asks each team for its next game, with the free key", async () => {
    eventfinda([]);
    const { requests } = sportsdb({});

    await fetchEvents();

    expect(requests.map((url) => url.pathname)).toEqual(
      Array(4).fill("/api/v1/json/123/eventsnext.php")
    );
  });

  it("needs Eventfinda's credentials", async () => {
    vi.stubEnv("EVENTFINDA_PASSWORD", "");
    sportsdb({});

    await expect(fetchEvents()).rejects.toThrow("eventfinda: no credentials");
  });

  it("fails when either source does", async () => {
    eventfinda([], 401);
    sportsdb({});

    await expect(fetchEvents()).rejects.toThrow("eventfinda: HTTP 401");

    eventfinda([]);
    sportsdb({}, 429);

    await expect(fetchEvents()).rejects.toThrow("thesportsdb: HTTP 429");
  });

  it("fails when Eventfinda's answer isn't what's expected", async () => {
    eventfinda([{ name: "No sessions" }]);
    sportsdb({});

    await expect(fetchEvents()).rejects.toThrow(
      "eventfinda: unexpected response"
    );
  });
});

describe("what a listing is", () => {
  it("goes by its category's name, then its parent's", () => {
    expect(kindOf({ name: "Classical Music", parent_id: 1 })).toBe("classical");
    expect(kindOf({ name: "Choir, Vocal Music", parent_id: 1 })).toBe(
      "classical"
    );
    expect(kindOf({ name: "Comedy", parent_id: 1 })).toBe("comedy");
    expect(kindOf({ name: "Rugby Union", parent_id: 7 })).toBe("rugby");
    expect(kindOf({ name: "Alternative, Indie", parent_id: 6 })).toBe("music");
    expect(kindOf({ name: "Musicals", parent_id: 1 })).toBe("theatre");
    expect(kindOf({ name: "Drag Performance", parent_id: 1 })).toBe("theatre");
    expect(kindOf({ name: "Family Entertainment", parent_id: 190 })).toBe(
      "theatre"
    );
  });

  it("isn't a show for talks, classes, markets and exhibitions", () => {
    expect(kindOf({ name: "Public Talks & Tours", parent_id: 3 })).toBeNull();
    expect(kindOf({ name: "Markets and Fairs", parent_id: 190 })).toBeNull();
    expect(kindOf({ name: "Contemporary Art", parent_id: 11 })).toBeNull();
    expect(kindOf({ name: "Mind & Body", parent_id: 3 })).toBeNull();
  });
});
