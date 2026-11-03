import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Fix, RouteEnd } from "../../src/lib/flights";
import {
  flights,
  routes,
  sortTime,
  traffic,
  trains,
  vessels,
  weather,
} from "../../src/lib/liveRecords";
import type { Vessel } from "../../src/lib/vessels";
import * as flightsRoute from "../../src/pages/api/flights";
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
});
