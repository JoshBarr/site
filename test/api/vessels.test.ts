import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toNztm } from "../../src/lib/nztm";
import * as route from "../../src/pages/api/vessels";
import { ago, freezeTime, NOW } from "../clock";
import { server } from "../msw";
import { call } from "../next";
import { redis } from "../redis";

const HARBOUR = "https://ais.openwaters.io/v1/vessels";
const TRACK = "https://ais.openwaters.io/v1/vessels/:mmsi/track";
const KNOTS = 1852 / 3600;

type LonLat = [number, number];

/** NZTM to the decimetre, as ships are placed. */
function at([lon, lat]: LonLat): [number, number] {
  const [easting, northing] = toNztm(lat, lon);

  return [Math.round(easting * 10) / 10, Math.round(northing * 10) / 10];
}

const iso = (time: number) => new Date(time).toISOString();

/** Places in the harbour, longitude and latitude. */
const QUEENS_WHARF: LonLat = [174.7808, -41.2814];
const OFF_ORIENTAL_BAY: LonLat = [174.7982, -41.2828];
const MID_HARBOUR: LonLat = [174.8287, -41.2805];
const EASTBOURNE: LonLat = [174.8486, -41.281];

interface Ship {
  mmsi: number;
  at: LonLat;
  seen: number;
  [property: string]: string | number | LonLat;
}

/** Ships as Open Waters lists them, trimmed. */
const harbour = (ships: Ship[]) => ({
  attribution: { station: "Open Waters AIS (https://openwaters.io/ais/)" },
  features: ships.map(({ at, seen, ...properties }) => ({
    type: "Feature",
    id: properties.mmsi,
    geometry: { type: "Point", coordinates: at },
    properties: { kind: "vessel", ...properties, seen: iso(seen) },
  })),
});

/** A ship's track, as Open Waters sends it. */
const track = (points: { at: LonLat; time: number; sog: number }[]) => ({
  geometry:
    points.length === 1
      ? { type: "Point", coordinates: points[0].at }
      : { type: "LineString", coordinates: points.map((p) => p.at) },
  properties: {
    times: points.map((p) => iso(p.time).replace(".000Z", "Z")),
    sog: points.map((p) => p.sog),
    cog: points.map(() => 270),
    heading: points.map(() => null),
    points: points.length,
  },
});

const ferry: Ship = {
  mmsi: 512003410,
  at: OFF_ORIENTAL_BAY,
  seen: ago(20),
  name: "COBAR CAT",
  type: 60,
  sog: 16.7,
  cog: 253.6,
  to_bow: 6,
  to_stern: 10,
  to_port: 3,
  to_starboard: 3,
};

const moored: Ship = {
  mmsi: 512008749,
  at: QUEENS_WHARF,
  seen: ago(300),
  name: "  LATTITUDE ADJUSTMENT ",
  type: 36,
  sog: 0.1,
  cog: 48.7,
};

const tug: Ship = {
  mmsi: 512229000,
  at: QUEENS_WHARF,
  seen: ago(600),
  name: "",
  heading: 326,
  to_bow: 13,
};

const ferryTrack = [
  { at: EASTBOURNE, time: ago(80), sog: 16.3 },
  { at: MID_HARBOUR, time: ago(50), sog: 16.2 },
  { at: OFF_ORIENTAL_BAY, time: ago(30), sog: 16.7 },
];

/** Answers Open Waters, returning the requests made of it. */
function openWaters(
  ships: () => Response,
  tracks: (mmsi: string) => Response = () => HttpResponse.json(track([]))
) {
  const requests: Request[] = [];

  server.use(
    http.get(HARBOUR, ({ request }) => {
      requests.push(request);

      return ships();
    }),
    http.get(TRACK, ({ request, params }) => {
      requests.push(request);

      return tracks(String(params.mmsi));
    })
  );

  return requests;
}

describe("/api/vessels", () => {
  beforeEach(() => freezeTime());

  describe("without Redis", () => {
    beforeEach(() => vi.stubEnv("UPSTASH_REDIS_REST_URL", ""));

    it("serves the ships in the harbour, with where those under way have been", async () => {
      const requests = openWaters(
        () => HttpResponse.json(harbour([ferry, moored, tug])),
        () => HttpResponse.json(track(ferryTrack))
      );

      const response = await call(route);

      expect(response.status).toBe(200);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=10, stale-while-revalidate=20"
      );

      expect(await response.json()).toEqual({
        time: NOW,
        vessels: [
          {
            mmsi: 512003410,
            name: "COBAR CAT",
            type: 60,
            // Where its track ends.
            position: at(OFF_ORIENTAL_BAY),
            speed: 16.7 * KNOTS,
            course: 270,
            heading: null,
            dimension: [6, 10, 3, 3],
            time: ago(30),
            trail: ferryTrack.map((p) => [...at(p.at), p.time]),
          },
          {
            mmsi: 512008749,
            name: "LATTITUDE ADJUSTMENT",
            type: 36,
            position: at(QUEENS_WHARF),
            speed: 0.1 * KNOTS,
            course: 48.7,
            heading: null,
            dimension: null,
            time: ago(300),
            trail: [],
          },
          {
            mmsi: 512229000,
            name: null,
            type: 0,
            position: at(QUEENS_WHARF),
            speed: 0,
            course: null,
            heading: 326,
            dimension: null,
            time: ago(600),
            trail: [],
          },
        ],
      });

      const [ships, ferryTrackRequest] = requests.map((r) => new URL(r.url));

      expect(Object.fromEntries(ships.searchParams)).toEqual({
        bbox: "-41.4,174.74,-41.19,174.96",
        kind: "vessel",
        max_age: "43200",
        max_age_moving: "600",
      });

      // Only the ship under way, for as far back as trails go.
      expect(requests).toHaveLength(2);
      expect(ferryTrackRequest.pathname).toBe("/v1/vessels/512003410/track");

      expect(Object.fromEntries(ferryTrackRequest.searchParams)).toEqual({
        from: iso(NOW - 15 * 60_000),
        interval: "0",
      });
    });

    it("places a ship where it was last heard when its track can't be had", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      openWaters(
        () => HttpResponse.json(harbour([ferry])),
        () => new HttpResponse(null, { status: 429 })
      );

      const response = await call(route);
      const [vessel] = (await response.json()).vessels;

      expect(vessel).toMatchObject({
        position: at(OFF_ORIENTAL_BAY),
        time: ago(20),
        trail: [],
      });
    });

    it("is unavailable when Open Waters fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      openWaters(() => new HttpResponse(null, { status: 502 }));

      const response = await call(route);

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
      expect(await response.json()).toEqual({ error: "vessels unavailable" });
    });

    it("is unavailable when Open Waters' answer isn't as expected", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      openWaters(() =>
        HttpResponse.json({ features: [{ properties: { mmsi: "x" } }] })
      );

      const response = await call(route);

      expect(response.status).toBe(502);
    });
  });

  describe("with Redis", () => {
    const vessel = (ship: Ship, trail: [number, number, number][]) => ({
      mmsi: ship.mmsi,
      name: "SHIP",
      type: 60,
      position: at(ship.at),
      speed: 8,
      course: 90,
      heading: null,
      dimension: null,
      time: ship.seen,
      trail,
    });

    it("remembers which way ships point", async () => {
      openWaters(() => HttpResponse.json(harbour([ferry, moored, tug])));

      const response = await call(route);

      expect(response.status).toBe(200);

      expect(redis.hash("vessels:headings")).toEqual({
        // Under way without a heading: its course.
        "512003410": "253.6",
        // Its own.
        "512229000": "326",
      });
    });

    it("points a moored ship that doesn't say as it last pointed", async () => {
      redis.seedHash("vessels:headings", { "512008749": "48" });
      openWaters(() => HttpResponse.json(harbour([moored, tug])));

      const response = await call(route);
      const [served] = (await response.json()).vessels;

      expect(served).toMatchObject({ mmsi: moored.mmsi, heading: 48 });
    });

    it("leaves a moored ship's heading unknown if it never said", async () => {
      openWaters(() => HttpResponse.json(harbour([moored])));

      const response = await call(route);
      const [served] = (await response.json()).vessels;

      expect(served).toMatchObject({ mmsi: moored.mmsi, heading: null });
    });

    it("fetches tracks on from where trails end, and adds to them", async () => {
      const trail: [number, number, number][] = [
        [...at(EASTBOURNE), ago(120)],
        [...at(MID_HARBOUR), ago(60)],
      ];

      redis.seed("vessels:snapshot", {
        time: ago(25),
        vessels: [vessel(ferry, trail)],
      });

      const requests = openWaters(
        () => HttpResponse.json(harbour([ferry])),
        () =>
          HttpResponse.json(
            track([{ at: OFF_ORIENTAL_BAY, time: ago(30), sog: 16.7 }])
          )
      );

      const response = await call(route);
      const [served] = (await response.json()).vessels;

      expect(served.trail).toEqual([
        ...trail,
        [...at(OFF_ORIENTAL_BAY), ago(30)],
      ]);

      expect(new URL(requests[1].url).searchParams.get("from")).toBe(
        iso(ago(60))
      );
    });

    it("leaves out ships gone quiet: soon if under way, after hours if not", async () => {
      redis.seed("vessels:snapshot", {
        time: ago(5),
        vessels: [
          { ...vessel(ferry, []), time: ago(11 * 60) },
          { ...vessel(moored, []), speed: 0, time: ago(11 * 3600) },
          { ...vessel(tug, []), speed: 0, time: ago(13 * 3600) },
        ],
      });

      const requests = openWaters(() => HttpResponse.json(harbour([])));

      const response = await call(route);
      const { vessels } = await response.json();

      expect(vessels.map((v: { mmsi: number }) => v.mmsi)).toEqual([
        moored.mmsi,
      ]);

      expect(requests).toHaveLength(0);
    });

    it("serves the last snapshot when Open Waters fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      redis.seed("vessels:snapshot", {
        time: ago(60),
        vessels: [vessel(ferry, [])],
      });

      openWaters(() => new HttpResponse(null, { status: 500 }));

      const response = await call(route);

      expect(response.status).toBe(200);
      expect((await response.json()).vessels).toEqual([vessel(ferry, [])]);
    });
  });
});
