import { HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toNztm } from "../../src/lib/nztm";
import * as route from "../../src/pages/api/buses";
import { ago, freezeTime, NOW } from "../clock";
import { answer, metlink, PLACES } from "../fixtures/metlink";
import { call } from "../next";
import { redis } from "../redis";

/** NZTM to the decimetre, as buses are placed. */
function at({ lat, lon }: { lat: number; lon: number }): [number, number] {
  const [easting, northing] = toNztm(lat, lon);

  return [Math.round(easting * 10) / 10, Math.round(northing * 10) / 10];
}

const stored = z.object({
  time: z.number(),
  buses: z.array(
    z.object({ id: z.string(), trail: z.array(z.array(z.number())) })
  ),
});

const lambtonQuay = at(PLACES.lambtonQuay);
const courtenayPlace = at(PLACES.courtenayPlace);

/** A bus as stored and served. */
const bus = (id: string, trail: [number, number, number][]) => {
  const [easting, northing, time] = trail[trail.length - 1];

  return {
    id,
    route: "40",
    direction: 1,
    position: [easting, northing],
    bearing: 270,
    time,
    trail,
  };
};

describe("/api/buses", () => {
  beforeEach(() => freezeTime());

  describe("without Redis", () => {
    beforeEach(() => vi.stubEnv("UPSTASH_REDIS_REST_URL", ""));

    it("serves the buses on trips around Wellington, from Metlink", async () => {
      const requests = metlink(
        answer([
          {
            id: "2158",
            ...PLACES.lambtonQuay,
            bearing: 270,
            time: ago(15),
            trip: { route: 40, direction: 1 },
          },
          {
            id: 3301,
            ...PLACES.courtenayPlace,
            time: ago(20),
            trip: { route: "83", direction: 0 },
          },
          // A train.
          {
            id: "FP4123",
            ...PLACES.wellingtonStation,
            time: ago(10),
            trip: { route: 2, direction: 0 },
          },
          // The cable car.
          {
            id: "CC1",
            ...PLACES.lambtonQuay,
            time: ago(10),
            trip: { route: 9, direction: 0 },
          },
          // Out of service.
          { id: "2001", ...PLACES.courtenayPlace, time: ago(10) },
          {
            id: "2002",
            ...PLACES.courtenayPlace,
            time: ago(10),
            trip: { route: "", direction: 0 },
          },
          // Off the map.
          {
            id: "2400",
            ...PLACES.masterton,
            time: ago(10),
            trip: { route: 200, direction: 0 },
          },
          // Gone quiet.
          {
            id: "2777",
            ...PLACES.lambtonQuay,
            time: ago(6 * 60),
            trip: { route: 1, direction: 0 },
          },
        ])
      );

      const response = await call(route);

      expect(response.status).toBe(200);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=5, stale-while-revalidate=10"
      );

      expect(await response.json()).toEqual({
        time: NOW,
        buses: [
          bus("2158", [[...lambtonQuay, ago(15)]]),
          {
            id: "3301",
            route: "83",
            direction: 0,
            position: courtenayPlace,
            bearing: null,
            time: ago(20),
            trail: [[...courtenayPlace, ago(20)]],
          },
        ],
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].headers.get("x-api-key")).toBe("metlink-key");
    });

    it("is unavailable when Metlink fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      metlink(() => new HttpResponse(null, { status: 500 }));

      const response = await call(route);

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
      expect(await response.json()).toEqual({ error: "buses unavailable" });
    });

    it("is unavailable when Metlink's answer isn't as expected", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      metlink(() =>
        HttpResponse.json({ entity: [{ vehicle: { vehicle: { id: "1" } } }] })
      );

      const response = await call(route);

      expect(response.status).toBe(502);
    });

    it("is unavailable without an API key, and doesn't ask", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv("METLINK_API_KEY", "");
      const requests = metlink(answer([]));

      const response = await call(route);

      expect(response.status).toBe(502);
      expect(requests).toHaveLength(0);
    });
  });

  describe("with Redis", () => {
    const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

    it("stores what it fetches, holding a lock while it does", async () => {
      metlink(
        answer([
          {
            id: "2158",
            ...PLACES.lambtonQuay,
            bearing: 270,
            time: ago(15),
            trip: { route: 40, direction: 1 },
          },
        ])
      );

      const response = await call(route);

      expect(await response.json()).toEqual({
        time: NOW,
        buses: [bus("2158", [[...lambtonQuay, ago(15)]])],
      });

      expect(redis.read("buses:snapshot", stored)).toEqual({
        time: NOW,
        buses: [{ id: "2158", trail: [[...lambtonQuay, ago(15)]] }],
      });

      expect(redis.commands("SET")[0]).toEqual(
        expect.arrayContaining(["buses:lock", "nx", "px", "10000"])
      );
    });

    it("serves a fresh snapshot without asking Metlink", async () => {
      redis.seed("buses:snapshot", {
        time: ago(5),
        buses: [
          bus("2158", [[...lambtonQuay, ago(20)]]),
          // Gone quiet.
          bus("2777", [[...courtenayPlace, ago(5 * 60 + 1)]]),
        ],
      });

      const requests = metlink(answer([]));

      const response = await call(route);

      expect(await response.json()).toEqual({
        time: NOW,
        buses: [bus("2158", [[...lambtonQuay, ago(20)]])],
      });

      expect(requests).toHaveLength(0);
    });

    it("carries trails on while a bus stays on its trip", async () => {
      redis.seed("buses:snapshot", {
        time: ago(30),
        buses: [
          bus("2158", [
            // By now, too old to draw.
            [...courtenayPlace, ago(200)],
            [...courtenayPlace, ago(60)],
            [...lambtonQuay, ago(30)],
          ]),
          bus("2160", [[...lambtonQuay, ago(30)]]),
        ],
      });

      metlink(
        answer([
          {
            id: "2158",
            ...PLACES.courtenayPlace,
            bearing: 270,
            time: ago(5),
            trip: { route: 40, direction: 1 },
          },
          // Now on another trip.
          {
            id: "2160",
            ...PLACES.courtenayPlace,
            bearing: 270,
            time: ago(5),
            trip: { route: 40, direction: 0 },
          },
        ])
      );

      const response = await call(route);
      const { buses } = await response.json();

      expect(buses).toEqual([
        bus("2158", [
          [...courtenayPlace, ago(60)],
          [...lambtonQuay, ago(30)],
          [...courtenayPlace, ago(5)],
        ]),
        {
          ...bus("2160", [[...courtenayPlace, ago(5)]]),
          direction: 0,
        },
      ]);
    });

    it("serves the last snapshot when Metlink fails", async () => {
      quiet();

      redis.seed("buses:snapshot", {
        time: ago(60),
        buses: [bus("2158", [[...lambtonQuay, ago(60)]])],
      });

      metlink(() => new HttpResponse(null, { status: 500 }));

      const response = await call(route);

      expect(response.status).toBe(200);

      expect(await response.json()).toEqual({
        time: NOW,
        buses: [bus("2158", [[...lambtonQuay, ago(60)]])],
      });
    });

    it("doesn't ask Metlink while someone else is", async () => {
      redis.seed("buses:snapshot", {
        time: ago(30),
        buses: [bus("2158", [[...lambtonQuay, ago(30)]])],
      });

      redis.seed("buses:lock", 1);
      const requests = metlink(answer([]));

      const response = await call(route);

      expect((await response.json()).buses).toHaveLength(1);
      expect(requests).toHaveLength(0);
    });

    it("starts again when what's stored isn't as expected", async () => {
      const error = quiet();

      // Stored by a deploy that kept Metlink's numeric ids.
      redis.seed("buses:snapshot", {
        time: ago(1),
        buses: [{ ...bus("2158", [[...lambtonQuay, ago(30)]]), id: 2158 }],
      });

      metlink(
        answer([
          {
            id: "2158",
            ...PLACES.lambtonQuay,
            bearing: 270,
            time: ago(15),
            trip: { route: 40, direction: 1 },
          },
        ])
      );

      const response = await call(route);

      expect(await response.json()).toEqual({
        time: NOW,
        buses: [bus("2158", [[...lambtonQuay, ago(15)]])],
      });

      expect(error).toHaveBeenCalledWith(
        "[redis] buses:snapshot:",
        expect.stringContaining("expected string")
      );
    });
  });
});
