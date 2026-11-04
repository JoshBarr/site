import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toNztm } from "../../src/lib/nztm";
import { fetchHarbour, fetchTrack } from "../../src/lib/openwaters";
import { pollHarbour } from "../../src/lib/vesselStore";
import { ago, freezeTime, NOW } from "../clock";
import { server } from "../msw";

// Open Waters' AIS: the ships in the harbour, and where each has been,
// read into the vessels the poller logs.

const HARBOUR = "https://ais.openwaters.io/v1/vessels";
const TRACK = "https://ais.openwaters.io/v1/vessels/:mmsi/track";

const KNOTS = 1852 / 3600;
const MINUTE = 60_000;

const iso = (time: number) => new Date(time).toISOString();

/** NZTM to the decimetre, as ships are placed. */
function at([lon, lat]: [number, number]): [number, number] {
  const [easting, northing] = toNztm(lat, lon);

  return [Math.round(easting * 10) / 10, Math.round(northing * 10) / 10];
}

const OFF_ORIENTAL_BAY: [number, number] = [174.7982, -41.2828];
const MID_HARBOUR: [number, number] = [174.8287, -41.2805];
const QUEENS_WHARF: [number, number] = [174.7808, -41.2814];

/** A ship as Open Waters lists it, heard from `seconds` ago. */
const ship = (
  mmsi: number,
  coordinates: [number, number],
  properties: Record<string, number | string> = {},
  seconds = 20
) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates },
  properties: { mmsi, kind: "vessel", seen: iso(ago(seconds)), ...properties },
});

/** A track through `points`, each at its time, all at `knots`. */
const track = (
  points: { at: [number, number]; time: number }[],
  knots = 12
) => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: points.map(({ at }) => at) },
  properties: {
    times: points.map(({ time }) => iso(time)),
    sog: points.map(() => knots),
    cog: points.map(() => 250),
    heading: points.map(() => null),
  },
});

/** Open Waters answering with `features` in the harbour. */
function harbour(features: unknown[]) {
  const requests: Request[] = [];

  server.use(
    http.get(HARBOUR, ({ request }) => {
      requests.push(request);

      return HttpResponse.json({ type: "FeatureCollection", features });
    })
  );

  return requests;
}

describe("Open Waters", () => {
  beforeEach(() => freezeTime());

  describe("the harbour", () => {
    it("asks for ships in it, by how long since each was heard", async () => {
      const requests = harbour([]);

      await fetchHarbour(6 * 3600_000, 5 * MINUTE);

      const params = new URL(requests[0].url).searchParams;

      expect(Object.fromEntries(params)).toEqual({
        bbox: "-41.4,174.74,-41.19,174.96",
        kind: "vessel",
        max_age: "21600",
        max_age_moving: "300",
      });

      expect(requests[0].headers.get("user-agent")).toBe("joshbarr.com scene");
    });

    it("asks with a token of its own, if it has one", async () => {
      const requests = harbour([]);

      await fetchHarbour(1, 1);
      vi.stubEnv("OPENWATERS_TOKEN", "ow-token");
      await fetchHarbour(1, 1);

      expect(requests.map((r) => r.headers.get("authorization"))).toEqual([
        null,
        "Bearer ow-token",
      ]);
    });

    it("places each ship in NZTM, in m/s", async () => {
      harbour([
        ship(512003410, OFF_ORIENTAL_BAY, {
          name: "  COBAR CAT ",
          type: 60,
          sog: 16.7,
          cog: 253.6,
          heading: 251,
          to_bow: 20,
          to_stern: 5,
          to_port: 4,
          to_starboard: 4,
        }),
      ]);

      expect(await fetchHarbour(1, 1)).toEqual([
        {
          mmsi: 512003410,
          name: "COBAR CAT",
          type: 60,
          position: at(OFF_ORIENTAL_BAY),
          speed: 16.7 * KNOTS,
          course: 253.6,
          heading: 251,
          dimension: [20, 5, 4, 4],
          time: ago(20),
          trail: [],
        },
      ]);
    });

    it("goes without what a ship doesn't say", async () => {
      harbour([ship(1, QUEENS_WHARF, { name: "   " })]);

      expect(await fetchHarbour(1, 1)).toEqual([
        expect.objectContaining({
          name: null,
          type: 0,
          speed: 0,
          course: null,
          heading: null,
          dimension: null,
        }),
      ]);
    });

    it("has no size for a ship that's only half said, or said as nothing", async () => {
      harbour([
        ship(1, QUEENS_WHARF, { to_bow: 20, to_stern: 5 }),
        ship(2, QUEENS_WHARF, {
          to_bow: 0,
          to_stern: 0,
          to_port: 0,
          to_starboard: 0,
        }),
        ship(3, QUEENS_WHARF, { to_port: 4, to_starboard: 4 }),
      ]);

      expect((await fetchHarbour(1, 1)).map((v) => v.dimension)).toEqual([
        null,
        null,
        null,
      ]);
    });

    it("fails when Open Waters does", async () => {
      server.use(
        http.get(HARBOUR, () => new HttpResponse(null, { status: 429 }))
      );

      await expect(fetchHarbour(1, 1)).rejects.toThrow(
        "openwaters /vessels: HTTP 429"
      );
    });
  });

  describe("a ship's track", () => {
    it("is every position heard since a time, oldest first", async () => {
      let asked: URL | undefined;

      server.use(
        http.get(TRACK, ({ request, params }) => {
          asked = new URL(request.url);
          expect(params.mmsi).toBe("512003410");

          return HttpResponse.json(
            track([
              { at: MID_HARBOUR, time: ago(40) },
              { at: OFF_ORIENTAL_BAY, time: ago(25) },
            ])
          );
        })
      );

      expect(await fetchTrack(512003410, ago(600))).toEqual([
        {
          position: at(MID_HARBOUR),
          time: ago(40),
          speed: 12 * KNOTS,
          course: 250,
          heading: null,
        },
        {
          position: at(OFF_ORIENTAL_BAY),
          time: ago(25),
          speed: 12 * KNOTS,
          course: 250,
          heading: null,
        },
      ]);

      expect(asked?.searchParams.get("from")).toBe(iso(ago(600)));
      expect(asked?.searchParams.get("interval")).toBe("0");
    });

    it("is one position, heard once", async () => {
      server.use(
        http.get(TRACK, () =>
          HttpResponse.json({
            geometry: { type: "Point", coordinates: MID_HARBOUR },
            properties: {
              times: [iso(ago(30))],
              sog: [null],
              cog: [null],
              heading: [90],
            },
          })
        )
      );

      expect(await fetchTrack(1, ago(600))).toEqual([
        {
          position: at(MID_HARBOUR),
          time: ago(30),
          speed: 0,
          course: null,
          heading: 90,
        },
      ]);
    });

    it("is nothing, heard nothing", async () => {
      server.use(
        http.get(TRACK, () =>
          HttpResponse.json({
            geometry: null,
            properties: { times: [], sog: [], cog: [], heading: [] },
          })
        )
      );

      expect(await fetchTrack(1, ago(600))).toEqual([]);
    });
  });
});

describe("polling the harbour", () => {
  let tracked: { mmsi: string; from: string }[];

  beforeEach(() => {
    freezeTime();
    tracked = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /** Answers each ship's track with `points`, or fails it. */
  function tracks(answer: (mmsi: string) => Response) {
    server.use(
      http.get(TRACK, ({ request, params }) => {
        const mmsi = String(params.mmsi);

        tracked.push({
          mmsi,
          from: new URL(request.url).searchParams.get("from") ?? "",
        });

        return answer(mmsi);
      })
    );
  }

  it("tracks only ships under way, from where their trails end", async () => {
    harbour([
      ship(1, OFF_ORIENTAL_BAY, { sog: 12 }),
      ship(2, MID_HARBOUR, { sog: 12 }),
      ship(3, QUEENS_WHARF, { sog: 0 }),
    ]);

    tracks(() => HttpResponse.json(track([])));

    // Ship 2's trail ended long ago: no further back than 15 minutes.
    await pollHarbour(
      new Map([
        [1, ago(90)],
        [2, NOW - 60 * MINUTE],
      ])
    );

    expect(tracked).toEqual([
      { mmsi: "1", from: iso(ago(90)) },
      { mmsi: "2", from: iso(NOW - 15 * MINUTE) },
    ]);
  });

  it("places a ship by its track, thinned to a point each ten seconds", async () => {
    harbour([ship(1, MID_HARBOUR, { sog: 12, heading: 245 }, 5)]);

    // Every two seconds for 30 seconds, ending off Oriental Bay.
    const points = Array.from({ length: 16 }, (_, i) => ({
      at: i === 15 ? OFF_ORIENTAL_BAY : MID_HARBOUR,
      time: ago(60 - i * 2),
    }));

    tracks(() => HttpResponse.json(track(points)));

    const [vessel] = await pollHarbour(new Map());

    expect(vessel).toMatchObject({
      position: at(OFF_ORIENTAL_BAY),
      // When it was there, not when it was last heard.
      time: ago(30),
      // Its own, where the track hasn't one.
      heading: 245,
    });

    expect(vessel.trail.map(([, , time]) => (NOW - time) / 1000)).toEqual([
      60, 50, 40, 30,
    ]);
  });

  it("leaves stops out of the trail", async () => {
    harbour([ship(1, MID_HARBOUR, { sog: 12 })]);

    tracks(() =>
      HttpResponse.json({
        ...track([
          { at: MID_HARBOUR, time: ago(60) },
          { at: OFF_ORIENTAL_BAY, time: ago(40) },
        ]),
        properties: {
          times: [iso(ago(60)), iso(ago(40))],
          sog: [0, 12],
          cog: [null, 250],
          heading: [null, null],
        },
      })
    );

    const [vessel] = await pollHarbour(new Map());

    expect(vessel.trail).toEqual([[...at(OFF_ORIENTAL_BAY), ago(40)]]);
  });

  it("keeps a ship as listed when its track fails", async () => {
    harbour([
      ship(1, MID_HARBOUR, { sog: 12 }),
      ship(2, OFF_ORIENTAL_BAY, { sog: 12 }),
    ]);

    tracks((mmsi) =>
      mmsi === "1"
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json(track([{ at: OFF_ORIENTAL_BAY, time: ago(30) }]))
    );

    const [failed, followed] = await pollHarbour(new Map());

    expect(failed).toMatchObject({
      position: at(MID_HARBOUR),
      time: ago(20),
      trail: [],
    });
    expect(followed.trail).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      "[vessels] track 1:",
      expect.any(Error)
    );
  });

  it("tracks no more than 30 ships a poll", async () => {
    harbour(
      Array.from({ length: 35 }, (_, i) =>
        ship(i + 1, MID_HARBOUR, { sog: 12 })
      )
    );

    tracks(() => HttpResponse.json(track([])));

    expect(await pollHarbour(new Map())).toHaveLength(35);
    expect(tracked).toHaveLength(30);
  });
});
