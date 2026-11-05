import { HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bus } from "../../src/lib/buses";
import type { Aircraft } from "../../src/lib/flights";
import type { Rainfall } from "../../src/lib/rainGauges";
import type { Train } from "../../src/lib/trains";
import type { Vessel } from "../../src/lib/vessels";
import * as buses from "../../src/pages/api/buses";
import * as flights from "../../src/pages/api/flights";
import * as quakes from "../../src/pages/api/quakes";
import * as rain from "../../src/pages/api/rain";
import * as tide from "../../src/pages/api/tide";
import * as traffic from "../../src/pages/api/traffic";
import * as trains from "../../src/pages/api/trains";
import * as vessels from "../../src/pages/api/vessels";
import * as weather from "../../src/pages/api/weather";
import { ago, freezeTime, NOW } from "../clock";
import { positionsAnswer, published } from "../fixtures/positions";
import { call } from "../next";

// The live layers' API routes, each serving its part of what the AWS poller
// last published.

const train = (id: string, seconds: number): Train => ({
  id,
  line: "KPL",
  direction: 0,
  position: [1748900, 5428300],
  bearing: 15,
  time: ago(seconds),
  trail: [[1748900, 5428300, ago(seconds)]],
});

const bus = (id: string, seconds: number): Bus => ({
  id,
  route: "40",
  direction: 1,
  position: [1748800, 5427900],
  bearing: 270,
  time: ago(seconds),
  trail: [[1748800, 5427900, ago(seconds)]],
});

const ship = (mmsi: number, speed: number, seconds: number): Vessel => ({
  mmsi,
  name: "COBAR CAT",
  type: 60,
  position: [1750500, 5428100],
  speed,
  course: 253.6,
  heading: null,
  dimension: null,
  time: ago(seconds),
  trail: [],
});

/** ANZ441, heard `seconds` ago for each of `heard`. */
const anz = (...heard: number[]): Aircraft => ({
  hex: "c81e2c",
  callsign: "ANZ441",
  registration: "ZK-NHA",
  type: "A21N",
  category: "A3",
  route: {
    from: { code: "AKL", at: [1757000, 5720000], elevation: null },
    to: { code: "WLG", at: [1749000, 5427000], elevation: 12.5 },
  },
  fixes: heard.map((seconds) => [
    1752000,
    5431000,
    945,
    ago(seconds),
    92.6,
    200,
    -3.6,
  ]),
});

const conditions = {
  time: "2026-11-02T07:00:00.000Z",
  cloudCover: 0.39,
  cloudBase: 1361.055,
  visibility: 29801.79,
  humidity: 0.87,
  precipitation: 0.5,
  wind: { speed: 10.2, direction: 329 },
  windAloft: { speed: 15.4, direction: 327.1 },
};

describe("the live API routes", () => {
  beforeEach(() => freezeTime());

  it("serve the trains, leaving out those gone quiet", async () => {
    published({ trains: [train("FP4123", 10), train("FP4200", 6 * 60)] });

    const response = await call(trains);

    expect(response.status).toBe(200);

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=5, stale-while-revalidate=10"
    );

    expect(await response.json()).toEqual({
      time: NOW,
      trains: [train("FP4123", 10)],
    });
  });

  it("serve the buses, leaving out those gone quiet", async () => {
    published({ buses: [bus("2158", 15), bus("2777", 6 * 60)] });

    const response = await call(buses);

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=10, stale-while-revalidate=10"
    );

    expect(await response.json()).toEqual({
      time: NOW,
      buses: [bus("2158", 15)],
    });
  });

  it("serve the ships: soon gone if under way, after hours if not", async () => {
    const underWay = ship(512003410, 8.6, 20);
    const moored = ship(512008749, 0, 3 * 3600);

    published({
      vessels: [underWay, moored, ship(1, 8.6, 11 * 60), ship(2, 0, 13 * 3600)],
    });

    const response = await call(vessels);

    expect(await response.json()).toEqual({
      time: NOW,
      vessels: [underWay, moored],
    });
  });

  describe("flights", () => {
    it("serve the last two minutes of each aircraft's fixes", async () => {
      published({
        aircraft: [
          anz(5 * 60, 60, 1),
          // Nothing that recent.
          { ...anz(5 * 60), hex: "7c6b2d", callsign: "QFA163" },
        ],
      });

      const response = await call(flights);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=10, stale-while-revalidate=10"
      );

      expect(await response.json()).toEqual({
        time: NOW,
        aircraft: [anz(60, 1)],
      });
    });

    it("go back seven minutes with ?history", async () => {
      published({ aircraft: [anz(8 * 60, 5 * 60, 1)] });

      const response = await call(flights, "/?history");

      expect((await response.json()).aircraft).toEqual([anz(5 * 60, 1)]);
    });

    it("leave a route out when it couldn't be looked up", async () => {
      const { route: _, ...unrouted } = anz(1);
      published({ aircraft: [unrouted] });

      const response = await call(flights);
      const [aircraft] = (await response.json()).aircraft;

      expect(aircraft).not.toHaveProperty("route");
    });
  });

  it("serve the speeds, with when they were fetched", async () => {
    const speeds = { links: { "Ngauranga To Aotea|2.1": 81 }, legs: {} };
    published({ traffic: { fetched: ago(40), ...speeds } });

    const response = await call(traffic);

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=60"
    );

    expect(await response.json()).toEqual({
      time: NOW,
      fetched: ago(40),
      ...speeds,
    });
  });

  it("serve the weather", async () => {
    published({ weather: conditions });

    const response = await call(weather);

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600"
    );

    expect(await response.json()).toEqual(conditions);
  });

  it("serve the quakes", async () => {
    const quake = {
      id: "2026p829637",
      time: ago(600),
      position: [1760000, 5440000] satisfies [number, number],
      depth: 20.1,
      magnitude: 3.2,
      locality: "20 km east of Paraparaumu",
      quality: "best",
    };

    published({ quakes: [quake] });

    const response = await call(quakes);

    expect(await response.json()).toEqual({ time: NOW, quakes: [quake] });
  });

  it("serve the tide", async () => {
    const level = { time: ago(240), level: 0.31, rate: -0.12 };
    published({ tide: level });

    const response = await call(tide);

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300"
    );

    expect(await response.json()).toEqual(level);
  });

  it("serve the rain gauges", async () => {
    const gauges: Rainfall = {
      time: ago(120),
      gauges: [{ position: [1748900, 5428300], rate: 2.4 }],
    };

    published({ rain: gauges });

    const response = await call(rain);

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300"
    );

    expect(await response.json()).toEqual(gauges);
  });

  describe("are unavailable, briefly cached", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it.each([
      ["trains", trains],
      ["buses", buses],
      ["flights", flights],
      ["vessels", vessels],
      ["traffic", traffic],
    ])("when the %s can't be had", async (name, route) => {
      positionsAnswer(() => new HttpResponse(null, { status: 403 }));

      const response = await call(route);

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
      expect(await response.json()).toEqual({ error: `${name} unavailable` });
    });

    it("when what's published isn't as expected", async () => {
      positionsAnswer(() => HttpResponse.json({ v: 2, trains: "all of them" }));

      const response = await call(trains);

      expect(response.status).toBe(502);
    });

    it("without anywhere to read them from", async () => {
      vi.stubEnv("LIVE_POSITIONS_URL", "");

      const response = await call(trains);

      expect(response.status).toBe(502);
    });

    it("when NZTA hasn't been heard from yet", async () => {
      published({});

      const response = await call(traffic);

      expect(response.status).toBe(502);
    });

    it("as the tide, from positions published before it was polled", async () => {
      positionsAnswer(() =>
        HttpResponse.json({
          v: 1,
          time: NOW,
          trains: [],
          buses: [],
          aircraft: [],
          vessels: [],
          traffic: null,
          weather: null,
        })
      );

      expect(await (await call(quakes)).json()).toEqual({
        time: NOW,
        quakes: [],
      });

      expect((await call(tide)).status).toBe(502);
      expect((await call(rain)).status).toBe(502);
    });

    it("when MetService hasn't, for a minute", async () => {
      published({});

      const response = await call(weather);

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("public, s-maxage=60");
    });
  });
});
