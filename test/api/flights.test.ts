import { HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Fix } from "../../src/lib/flights";
import { toNztm } from "../../src/lib/nztm";
import { ago, freezeTime, NOW } from "../clock";
import {
  adsb,
  AIRPORTS,
  airspace,
  ANZ441,
  NOT_DRAWN,
  QFA163,
  routeReply,
  TAXIING,
} from "../fixtures/adsb";
import { server } from "../msw";
import { call } from "../next";
import { redis } from "../redis";
import { afterResponse } from "../vercel";

const FEET = 0.3048;
const KNOTS = 1852 / 3600;

/** NZTM to the metre, as fixes are placed. */
function at(lat: number, lon: number): [number, number] {
  const [easting, northing] = toNztm(lat, lon);

  return [Math.round(easting), Math.round(northing)];
}

const anzFix: Fix = [
  ...at(ANZ441.lat, ANZ441.lon),
  // GNSS altitude.
  Math.round(3100 * FEET),
  ago(1),
  180 * KNOTS,
  200,
  (-704 * FEET) / 60,
];

const qfaFix: Fix = [
  ...at(QFA163.lat, QFA163.lon),
  // Pressure altitude, corrected by how far ANZ441's is out.
  Math.round((10000 + 100) * FEET),
  NOW,
  300 * KNOTS,
  250,
  0,
];

const taxiingFix: Fix = [
  ...at(TAXIING.lat, TAXIING.lon),
  null,
  ago(3),
  5 * KNOTS,
  90,
  null,
];

const anz = {
  hex: "c81e2c",
  callsign: "ANZ441",
  registration: "ZK-NHA",
  type: "A21N",
  category: "A3",
};

const wlg = {
  code: "WLG",
  at: at(AIRPORTS.WLG.lat, AIRPORTS.WLG.lon),
  elevation: 12.5,
};

const storedFix = z.tuple([
  z.string(),
  z.string().nullable(),
  z.string().nullable(),
  z.string().nullable(),
  z.string().nullable(),
  z.number(),
  z.number(),
  z.number().nullable(),
  z.number(),
  z.number(),
  z.number().nullable(),
  z.number().nullable(),
]);

/** A sighting as stored in Redis, for ANZ441, with `fix`. */
const stored = (fix: Fix) => [
  anz.hex,
  anz.callsign,
  anz.registration,
  anz.type,
  anz.category,
  ...fix,
];

/** ANZ441's fix, as heard `seconds` ago. */
function anzAgo(seconds: number): Fix {
  const [easting, northing, altitude, , ...rest] = anzFix;

  return [easting, northing, altitude, ago(seconds), ...rest];
}

/** Stores sightings of ANZ441, as earlier requests would have. */
function heard(...fixes: Fix[]) {
  redis.seedSortedSet(
    "flights:fixes",
    fixes.map((fix) => ({ score: fix[3], member: stored(fix) }))
  );
}

/** Each instance remembers routes, so each test starts a new one. */
async function load() {
  vi.resetModules();

  return import("../../src/pages/api/flights");
}

describe("/api/flights", () => {
  beforeEach(() => freezeTime());

  describe("without Redis", () => {
    beforeEach(() => vi.stubEnv("UPSTASH_REDIS_REST_URL", ""));

    it("serves the aircraft around Wellington, with their routes", async () => {
      const requests = adsb(
        () =>
          HttpResponse.json(airspace([ANZ441, QFA163, TAXIING, ...NOT_DRAWN])),
        () =>
          HttpResponse.json([
            routeReply("ANZ441", ["AKL", "WLG"]),
            routeReply("QFA163", ["SYD", "WLG"]),
          ])
      );

      const response = await call(await load());

      expect(response.status).toBe(200);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=15, stale-while-revalidate=20"
      );

      expect(await response.json()).toEqual({
        time: NOW,
        aircraft: [
          {
            ...anz,
            fixes: [anzFix],
            route: {
              from: { code: "AKL", at: expect.any(Array), elevation: null },
              to: wlg,
            },
          },
          {
            hex: "7c6b2d",
            callsign: "QFA163",
            registration: "VH-VXA",
            type: "B738",
            category: "A3",
            fixes: [qfaFix],
            route: {
              from: { code: "SYD", at: expect.any(Array), elevation: null },
              to: wlg,
            },
          },
          {
            hex: "c8233e",
            callsign: null,
            registration: "ZK-MCJ",
            type: "AT76",
            category: "A2",
            fixes: [taxiingFix],
            route: null,
          },
        ],
      });

      // Asked where each is, for the route each is flying.
      expect(await requests.routes[0].json()).toEqual({
        planes: [
          { callsign: "ANZ441", lat: ANZ441.lat, lng: ANZ441.lon },
          { callsign: "QFA163", lat: QFA163.lat, lng: QFA163.lon },
        ],
      });
    });

    it("places far-off airports 300 km along the way to them", async () => {
      adsb(
        () => HttpResponse.json(airspace([QFA163])),
        () => HttpResponse.json([routeReply("QFA163", ["SYD", "WLG"])])
      );

      const response = await call(await load());
      const [{ route }] = (await response.json()).aircraft;
      const [e, n] = route.from.at;

      // Roughly: NZTM is only so true that far out.
      const distance = Math.hypot(e - wlg.at[0], n - wlg.at[1]) / 1000;

      expect(distance).toBeGreaterThan(295);
      expect(distance).toBeLessThan(305);
    });

    it("picks the leg being flown, of a route with several", async () => {
      // Flying out of Wellington towards Auckland.
      adsb(
        () => HttpResponse.json(airspace([ANZ441])),
        () => HttpResponse.json([routeReply("ANZ441", ["NSN", "WLG", "AKL"])])
      );

      const response = await call(await load());
      const [{ route }] = (await response.json()).aircraft;

      expect(route.from).toEqual(wlg);
      expect(route.to.code).toBe("AKL");
    });

    it("places nearby airports where they are", async () => {
      adsb(
        () => HttpResponse.json(airspace([ANZ441])),
        () => HttpResponse.json([routeReply("ANZ441", ["NSN", "WLG"])])
      );

      const response = await call(await load());
      const [{ route }] = (await response.json()).aircraft;

      expect(route.from).toEqual({
        code: "NSN",
        at: at(AIRPORTS.NSN.lat, AIRPORTS.NSN.lon),
        elevation: 10.36,
      });
    });

    it("knows when a flight's route isn't known", async () => {
      adsb(
        () => HttpResponse.json(airspace([ANZ441])),
        () => HttpResponse.json([routeReply("ANZ441")])
      );

      const response = await call(await load());
      const [aircraft] = (await response.json()).aircraft;

      expect(aircraft.route).toBeNull();
    });

    it("serves aircraft without routes when they can't be looked up", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      adsb(
        () => HttpResponse.json(airspace([ANZ441])),
        () => HttpResponse.json([{ callsign: 441 }])
      );

      const response = await call(await load());
      const [aircraft] = (await response.json()).aircraft;

      expect(response.status).toBe(200);
      expect(aircraft).not.toHaveProperty("route");
      expect(aircraft.fixes).toEqual([anzFix]);
    });

    // Unlike the other routes: with nothing stored to fall back on, it
    // answers with nothing rather than being unavailable.
    it("serves no aircraft when adsb.lol fails", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      adsb(() => new HttpResponse(null, { status: 503 }));

      const response = await call(await load());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ time: NOW, aircraft: [] });

      expect(error).toHaveBeenCalledWith(
        "[flights] fetch failed:",
        expect.any(Error)
      );
    });

    it("serves no aircraft when adsb.lol's answer isn't as expected", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      adsb(() => HttpResponse.json({ ac: [{ hex: 1 }] }));

      const response = await call(await load());

      expect(await response.json()).toEqual({ time: NOW, aircraft: [] });

      expect(error).toHaveBeenCalledWith(
        "[flights] fetch failed:",
        expect.objectContaining({
          message: expect.stringContaining("adsb.lol: unexpected response"),
        })
      );
    });
  });

  describe("with Redis", () => {
    it("adds what's stored to the trails, and stores what's heard", async () => {
      const earlier = anzAgo(60);
      // Too long ago for an ordinary poll.
      const longAgo = anzAgo(10 * 60);
      heard(longAgo, earlier);

      adsb(
        () => HttpResponse.json(airspace([ANZ441])),
        () => HttpResponse.json([routeReply("ANZ441", ["AKL", "WLG"])])
      );

      const response = await call(await load());
      const [aircraft] = (await response.json()).aircraft;

      expect(aircraft.fixes).toEqual([earlier, anzFix]);

      await afterResponse();

      expect(redis.members("flights:fixes", storedFix)).toEqual([
        stored(longAgo),
        stored(earlier),
        stored(anzFix),
      ]);
    });

    it("goes back half an hour with ?history", async () => {
      const longAgo = anzAgo(10 * 60);
      heard(longAgo);

      adsb(
        () => HttpResponse.json(airspace([ANZ441])),
        () => HttpResponse.json([routeReply("ANZ441")])
      );

      const response = await call(await load(), "/?history");
      const [aircraft] = (await response.json()).aircraft;

      expect(aircraft.fixes).toEqual([longAgo, anzFix]);
    });

    it("keeps routes a day, and unknown ones an hour", async () => {
      adsb(
        () => HttpResponse.json(airspace([ANZ441, QFA163])),
        () =>
          HttpResponse.json([
            routeReply("ANZ441", ["AKL", "WLG"]),
            routeReply("QFA163"),
          ])
      );

      await call(await load());

      const sets = redis.commands("SET");

      expect(sets).toContainEqual(
        expect.arrayContaining(["flights:route:ANZ441", "ex", "86400"])
      );

      expect(sets).toContainEqual([
        "SET",
        "flights:route:QFA163",
        "[null]",
        "ex",
        "3600",
      ]);
    });

    it("uses stored routes without asking adsb.im", async () => {
      const route = {
        from: { code: "AKL", at: [1757000, 5920000], elevation: null },
        to: wlg,
      };

      redis.seed("flights:route:ANZ441", [route]);
      const requests = adsb(() => HttpResponse.json(airspace([ANZ441])));

      const response = await call(await load());
      const [aircraft] = (await response.json()).aircraft;

      expect(aircraft.route).toEqual(route);
      expect(requests.routes).toHaveLength(0);
    });

    it("serves what's stored when adsb.lol fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const earlier = anzAgo(60);
      heard(earlier);

      adsb(
        () => new HttpResponse(null, { status: 503 }),
        () => HttpResponse.json([routeReply("ANZ441")])
      );

      const response = await call(await load());

      expect(response.status).toBe(200);
      expect((await response.json()).aircraft[0].fixes).toEqual([earlier]);
    });

    it("leaves out sightings stored some other way", async () => {
      redis.seedSortedSet("flights:fixes", [
        { score: ago(30), member: ["c81e2c", ago(30)] },
      ]);
      adsb(() => HttpResponse.json(airspace([])));

      const response = await call(await load());

      expect(await response.json()).toEqual({ time: NOW, aircraft: [] });
    });

    it("is unavailable when adsb.lol and Redis both fail", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      adsb(() => new HttpResponse(null, { status: 503 }));
      server.use(...redis.down);

      const response = await call(await load());

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
      expect(await response.json()).toEqual({ error: "flights unavailable" });
    });
  });
});
