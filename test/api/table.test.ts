import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Fix, RouteEnd } from "../../src/lib/flights";
import {
  flights,
  quakes,
  routes,
  sortTime,
  tide,
  traffic,
  trains,
  vessels,
  weather,
} from "../../src/lib/liveRecords";
import type { Vessel } from "../../src/lib/vessels";
import * as flightsRoute from "../../src/pages/api/flights";
import * as quakesRoute from "../../src/pages/api/quakes";
import * as tideRoute from "../../src/pages/api/tide";
import * as trafficRoute from "../../src/pages/api/traffic";
import * as trainsRoute from "../../src/pages/api/trains";
import * as vesselsRoute from "../../src/pages/api/vessels";
import * as weatherRoute from "../../src/pages/api/weather";
import { ago, freezeTime, NOW } from "../clock";
import { liveTable, tableDenied } from "../fixtures/dynamo";
import { published } from "../fixtures/positions";
import { call } from "../next";

// The live API routes reading the poller's logs from the table, as they do
// once LIVE_TABLE is set, falling back on what it published.

type Point = [number, number];

const STATION: Point = [1748900, 5428300];
const PETONE: Point = [1757500, 5436900];

const train = (position: Point, seconds: number) => ({
  id: "FP4123",
  line: "HVL" as const,
  direction: 1,
  position,
  bearing: 200,
  time: ago(seconds),
});

const WLG: RouteEnd = { code: "WLG", at: [1749000, 5427000], elevation: 12.5 };
const NSN: RouteEnd = { code: "NSN", at: [1620000, 5432000], elevation: 10.36 };
const AKL: RouteEnd = { code: "AKL", at: [1757000, 5720000], elevation: null };

describe("the live API routes, from the table", () => {
  let table: ReturnType<typeof liveTable>;

  beforeEach(() => {
    freezeTime();
    vi.stubEnv("LIVE_TABLE", "scene-live-test");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
    table = liveTable();
  });

  it("fold each train's fixes over the trail's window", async () => {
    table.seed(trains, ago(50), { trains: [train(PETONE, 55)] });
    table.seed(trains, ago(10), { trains: [train(STATION, 12)] });

    const response = await call(trainsRoute);

    expect(await response.json()).toEqual({
      time: NOW,
      trains: [
        {
          ...train(STATION, 12),
          trail: [
            [...PETONE, ago(55)],
            [...STATION, ago(12)],
          ],
        },
      ],
    });

    // Three minutes, and a minute for fixes polled late.
    expect(table.queries[0].ExpressionAttributeValues[":from"]).toEqual({
      S: sortTime(ago(4 * 60)),
    });
  });

  it("serve moored ships from the newest poll, however old", async () => {
    const moored: Vessel = {
      mmsi: 512008749,
      name: "TUG",
      type: 52,
      position: STATION,
      speed: 0,
      course: null,
      heading: 120,
      dimension: null,
      time: ago(3 * 3600),
      trail: [],
    };

    table.seed(vessels, ago(3 * 3600), { vessels: [moored] });

    const response = await call(vesselsRoute);

    expect((await response.json()).vessels).toEqual([moored]);
  });

  it("join each aircraft to the leg it's flying, reading routes once", async () => {
    const heard = (at: Point, seconds: number) => ({
      aircraft: {
        hex: "c81e2c",
        callsign: "ANZ441",
        registration: "ZK-NHA",
        type: "A21N",
        category: "A3",
      },
      fix: [...at, 3000, ago(seconds), 120, 0, 5] satisfies Fix,
    });

    // Leaving Wellington, north.
    table.seed(flights, ago(60), {
      sightings: [heard([1751000, 5440000], 60)],
    });
    table.seed(flights, ago(5), { sightings: [heard([1752000, 5450000], 5)] });

    table.seed(
      routes,
      { callsign: "ANZ441", time: ago(3600) },
      { airports: [NSN, WLG, AKL] }
    );

    const response = await call(flightsRoute);
    const [aircraft] = (await response.json()).aircraft;

    expect(aircraft.route).toEqual({ from: WLG, to: AKL });
    expect(aircraft.fixes).toHaveLength(2);

    await call(flightsRoute);

    const routeQueries = table.queries.filter(
      ({ ExpressionAttributeValues }) =>
        ExpressionAttributeValues[":pk"]?.S === "routes"
    );

    expect(routeQueries).toHaveLength(1);
  });

  it("serve the newest speeds and weather", async () => {
    const speeds = { links: { "Ngauranga To Aotea|2.1": 81 }, legs: {} };
    table.seed(traffic, ago(120), { links: {}, legs: {} });
    table.seed(traffic, ago(30), speeds);

    const conditions = {
      time: "2026-11-02T07:00:00.000Z",
      cloudCover: 0.39,
      cloudBase: null,
      visibility: 30000,
      humidity: 0.87,
      precipitation: 0,
      wind: { speed: 10.2, direction: 329 },
      windAloft: { speed: 15.4, direction: 327.1 },
    };

    table.seed(weather, ago(600), conditions);

    const trafficResponse = await call(trafficRoute);

    expect(await trafficResponse.json()).toEqual({
      time: NOW,
      fetched: ago(30),
      ...speeds,
    });

    const weatherResponse = await call(weatherRoute);

    expect(await weatherResponse.json()).toEqual(conditions);
  });

  it("leave out polls written in a format they don't read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    table.seed(trains, ago(10), { trains: [train(STATION, 12)] });

    table.seedItem({
      pk: { S: "trains" },
      sk: { S: sortTime(ago(5)) },
      v: { N: "2" },
      data: { B: "" },
      expires: { N: "0" },
    });

    const response = await call(trainsRoute);

    expect((await response.json()).trains).toHaveLength(1);
  });

  it("serve what the poller published when the table can't be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    tableDenied();

    const trail: [number, number, number][] = [[...STATION, ago(12)]];
    const fallback = { ...train(STATION, 12), trail };

    published({ trains: [fallback] });

    const response = await call(trainsRoute);

    expect(response.status).toBe(200);
    expect((await response.json()).trains).toEqual([fallback]);

    expect(error).toHaveBeenCalledWith(
      "[trains] table read failed, using positions:",
      expect.anything()
    );
  });

  describe("replaying, with ?at=", () => {
    /** An hour ago: long enough for every poll up to then to be in. */
    const AT = ago(3600);

    /** `seconds` before AT. */
    const before = (seconds: number) => 3600 + seconds;

    const conditions = (cloudCover: number) => ({
      time: "2026-11-02T06:00:00.000Z",
      cloudCover,
      cloudBase: null,
      visibility: 30000,
      humidity: 0.87,
      precipitation: 0,
      wind: { speed: 10.2, direction: 329 },
      windAloft: { speed: 15.4, direction: 327.1 },
    });

    it("serve each layer as it was then, cached for a day", async () => {
      table.seed(trains, ago(before(50)), {
        trains: [train(PETONE, before(55))],
      });
      table.seed(trains, ago(before(10)), {
        trains: [train(STATION, before(12))],
      });
      // Polled since: not yet, then.
      table.seed(trains, ago(10), { trains: [train(PETONE, 12)] });

      const response = await call(trainsRoute, `/?at=${AT}`);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=86400"
      );

      expect(await response.json()).toEqual({
        time: AT,
        trains: [
          {
            ...train(STATION, before(12)),
            trail: [
              [...PETONE, ago(before(55))],
              [...STATION, ago(before(12))],
            ],
          },
        ],
      });
    });

    it("join aircraft to the route as looked up by then", async () => {
      const heard = {
        aircraft: {
          hex: "c81e2c",
          callsign: "ANZ441",
          registration: "ZK-NHA",
          type: "A21N",
          category: "A3",
        },
        fix: [1752000, 5450000, 3000, ago(before(5)), 120, 0, 5] satisfies Fix,
      };

      table.seed(flights, ago(before(5)), { sightings: [heard] });

      table.seed(
        routes,
        { callsign: "ANZ441", time: ago(before(3600)) },
        { airports: [WLG, AKL] }
      );

      table.seed(
        routes,
        { callsign: "ANZ441", time: ago(60) },
        { airports: [NSN, WLG] }
      );

      const response = await call(flightsRoute, `/?at=${AT}`);
      const [aircraft] = (await response.json()).aircraft;

      expect(aircraft.route).toEqual({ from: WLG, to: AKL });
    });

    it("serve the speeds and weather of then", async () => {
      const then = { links: { "Ngauranga To Aotea|2.1": 42 }, legs: {} };

      table.seed(traffic, ago(before(30)), then);
      table.seed(traffic, ago(30), { links: {}, legs: {} });
      table.seed(weather, ago(before(600)), conditions(0.9));
      table.seed(weather, ago(600), conditions(0.1));

      const trafficResponse = await call(trafficRoute, `/?at=${AT}`);

      expect(await trafficResponse.json()).toEqual({
        time: AT,
        fetched: ago(before(30)),
        ...then,
      });

      const weatherResponse = await call(weatherRoute, `/?at=${AT}`);

      expect(await weatherResponse.json()).toEqual(conditions(0.9));
    });

    it("serve the tide of then", async () => {
      table.seed(tide, ago(before(120)), {
        time: ago(before(300)),
        level: -0.41,
        rate: 0.2,
      });
      table.seed(tide, ago(60), { time: ago(240), level: 0.5, rate: -0.1 });

      const response = await call(tideRoute, `/?at=${AT}`);

      expect(await response.json()).toEqual({
        time: ago(before(300)),
        level: -0.41,
        rate: 0.2,
      });
    });

    it("serve the quakes reported soon after, to play as they strike", async () => {
      const quake = (id: string, seconds: number) => ({
        id,
        time: ago(seconds),
        position: [1760000, 5440000] satisfies Point,
        depth: 20,
        magnitude: 3.2,
        locality: "20 km east of Paraparaumu",
        quality: "automatic",
      });

      // Struck a minute after, reported four minutes after that.
      table.seed(quakes, ago(before(-300)), {
        quakes: [quake("then", before(-60))],
      });
      // Too long after.
      table.seed(quakes, ago(before(-30 * 60)), {
        quakes: [quake("then", before(-60)), quake("later", before(-1700))],
      });

      const response = await call(quakesRoute, `/?at=${AT}`);

      expect(await response.json()).toEqual({
        time: AT,
        quakes: [quake("then", before(-60))],
      });

      // Settled once those twenty minutes are.
      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=86400"
      );
    });

    it("cache the last few minutes as briefly as now", async () => {
      table.seed(trains, ago(40), { trains: [train(STATION, 42)] });

      const response = await call(trainsRoute, `/?at=${ago(30)}`);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=5, stale-while-revalidate=10"
      );
    });

    it("fail rather than serve what's published, which is now", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      tableDenied();
      published({ trains: [{ ...train(STATION, 12), trail: [] }] });

      const response = await call(trainsRoute, `/?at=${AT}`);

      expect(response.status).toBe(502);
    });

    it.each([
      ["further back than the logs go", ago(31 * 86_400)],
      ["yet to come", NOW + 5 * 60_000],
      ["that isn't one", "yesterday"],
    ])("refuse a time %s", async (_, at) => {
      const response = await call(trainsRoute, `/?at=${at}`);

      expect(response.status).toBe(400);
      expect(table.queries).toHaveLength(0);
    });
  });
});
