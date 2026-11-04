import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteEnd } from "../../src/lib/flights";
import {
  buses,
  flights,
  headings,
  routes,
  quakes,
  tide,
  timeline,
  traffic,
  trains,
  vessels,
  weather,
} from "../../src/lib/liveRecords";
import { toNztm } from "../../src/lib/nztm";
import { HOUR, hourOf } from "../../src/lib/timeline";
import { ago, freezeTime, NOW } from "../../test/clock";
import {
  adsb,
  airspace,
  ANZ441,
  NOT_DRAWN,
  QFA163,
  routeReply,
  TAXIING,
} from "../../test/fixtures/adsb";
import { answer, metlink, PLACES } from "../../test/fixtures/metlink";
import { server } from "../../test/msw";
import { Feed, makeFeeds } from "../poller/feeds";
import { pollMinute } from "../poller/minute";
import { KEY, LiveBucket, publisher } from "../poller/positions";
import { LiveTable } from "../poller/table";
import { counter } from "../poller/timeline";
import { makeBucket } from "./bucket";
import { makeTable } from "./table";

const DAY = 24 * 3600;
const FEET = 0.3048;
const KNOTS = 1852 / 3600;

/** NZTM to the decimetre, as trains and ships are placed. */
function at({ lat, lon }: { lat: number; lon: number }): [number, number] {
  const [easting, northing] = toNztm(lat, lon);

  return [Math.round(easting * 10) / 10, Math.round(northing * 10) / 10];
}

/** FP4123 at the station, as stored from a fix `seconds` ago. */
const train = (seconds: number) => ({
  id: "FP4123",
  line: "KPL" as const,
  direction: 0,
  position: at(PLACES.wellingtonStation),
  bearing: 15,
  time: ago(seconds),
});

/** Metlink reporting FP4123 at the station, `seconds` ago. */
const atStation = (seconds: number) =>
  answer([
    {
      id: "FP4123",
      ...PLACES.wellingtonStation,
      bearing: 15,
      time: ago(seconds),
      trip: { route: 2, direction: 0 },
    },
  ]);

let table: ReturnType<typeof makeTable>;
let bucket: ReturnType<typeof makeBucket>;

const run = <A, E>(effect: Effect.Effect<A, E, LiveTable | LiveBucket>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(LiveTable, table.service),
      Effect.provideService(LiveBucket, bucket.service)
    )
  );

type Logs = Effect.Success<typeof makeFeeds>["logs"];

/** A feed as a newly started container has it. */
async function coldFeed<K extends keyof Logs>(name: K) {
  return (await Effect.runPromise(makeFeeds)).logs[name];
}

describe("the poller", () => {
  beforeEach(() => {
    table = makeTable();
    bucket = makeBucket();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  describe("trains", () => {
    it("appends each poll to the log, as fetched", async () => {
      metlink(atStation(10));
      const feed = await coldFeed("trains");

      await run(feed.poll);

      expect(table.records(trains)).toEqual([
        {
          pk: "trains",
          sk: NOW,
          v: 1,
          data: { trains: [train(10)] },
          expires: NOW / 1000 + 30 * DAY,
        },
      ]);

      // Sorting as a string, by time.
      expect(table.items()[0]).toMatchObject({
        pk: { S: "trains" },
        sk: { S: String(NOW).padStart(13, "0") },
        v: { N: "1" },
        data: { B: expect.any(Uint8Array) },
      });
    });

    it("writes only when a train has a newer fix", async () => {
      let seconds = 10;
      metlink(() => atStation(seconds)());
      const feed = await coldFeed("trains");

      await run(feed.poll);
      await run(feed.poll);

      expect(table.records(trains)).toHaveLength(1);

      seconds = 5;
      freezeTime(NOW + 10_000);
      await run(feed.poll);

      expect(table.records(trains).map(({ data }) => data)).toEqual([
        { trains: [train(10)] },
        { trains: [train(5)] },
      ]);
    });

    it("goes by the newest item stored when it starts", async () => {
      table.seed(trains, ago(5), { trains: [train(10)] }, ago(5));
      metlink(atStation(10));

      await run((await coldFeed("trains")).poll);

      expect(table.records(trains)).toHaveLength(1);
    });

    it("writes over the top of an item it can't read", async () => {
      table.seedItem({
        pk: { S: "trains" },
        sk: { S: String(ago(5)).padStart(13, "0") },
        v: { N: "99" },
        data: { B: new Uint8Array([1, 2, 3]) },
        expires: { N: "0" },
      });

      vi.spyOn(console, "warn").mockImplementation(() => {});
      metlink(atStation(10));

      await run((await coldFeed("trains")).poll);

      expect(table.items().map(({ v }) => v?.N)).toEqual(["99", "1"]);
    });

    it("leaves out trains off the map", async () => {
      metlink(
        answer([
          {
            id: "FP4123",
            ...PLACES.wellingtonStation,
            bearing: 15,
            time: ago(10),
            trip: { route: 2, direction: 0 },
          },
          // Up the line in Palmerston North.
          {
            id: "FP4200",
            lat: -40.35,
            lon: 175.61,
            bearing: 15,
            time: ago(10),
            trip: { route: 2, direction: 0 },
          },
        ])
      );

      await run((await coldFeed("trains")).poll);

      expect(table.records(trains)[0].data).toEqual({ trains: [train(10)] });
    });
  });

  describe("Metlink", () => {
    const vehicles = answer([
      {
        id: "2158",
        ...PLACES.lambtonQuay,
        bearing: 270,
        time: ago(15),
        trip: { route: 40, direction: 1 },
      },
      {
        id: 4245,
        ...PLACES.petone,
        time: ago(12),
        trip: { route: 5, direction: 1 },
      },
      {
        id: "FP4123",
        ...PLACES.wellingtonStation,
        bearing: 15,
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
      // Off the map, a bus and a train.
      {
        id: "2400",
        ...PLACES.masterton,
        time: ago(10),
        trip: { route: 200, direction: 0 },
      },
      {
        id: "SW1",
        ...PLACES.masterton,
        time: ago(10),
        trip: { route: 4, direction: 0 },
      },
    ]);

    it("logs the buses on trips, on the map", async () => {
      const requests = metlink(vehicles);

      await run((await coldFeed("buses")).poll);

      expect(table.records(buses)[0].data).toEqual({
        buses: [
          {
            id: "2158",
            route: "40",
            direction: 1,
            position: at(PLACES.lambtonQuay),
            bearing: 270,
            time: ago(15),
          },
        ],
      });

      expect(requests[0].headers.get("x-api-key")).toBe("metlink-key");
    });

    it("logs the trains in service, by line, on the map", async () => {
      metlink(vehicles);

      await run((await coldFeed("trains")).poll);

      expect(table.records(trains)[0].data).toEqual({
        trains: [
          {
            id: "4245",
            line: "HVL",
            direction: 1,
            position: at(PLACES.petone),
            bearing: null,
            time: ago(12),
          },
          train(10),
        ],
      });
    });

    it("logs nothing when Metlink fails", async () => {
      metlink(() => new HttpResponse(null, { status: 500 }));

      await expect(run((await coldFeed("trains")).poll)).rejects.toThrow();

      expect(table.items()).toEqual([]);
    });
  });

  describe("flights", () => {
    it("logs what's heard, as NZTM fixes in metres", async () => {
      adsb(
        () =>
          HttpResponse.json(airspace([ANZ441, QFA163, TAXIING, ...NOT_DRAWN])),
        () => HttpResponse.json([])
      );

      await run((await coldFeed("flights")).poll);

      const [{ data }] = table.records(flights);

      const nztm = (lat: number, lon: number) =>
        toNztm(lat, lon).map(Math.round);

      expect(data.sightings).toEqual([
        {
          aircraft: {
            hex: "c81e2c",
            callsign: "ANZ441",
            registration: "ZK-NHA",
            type: "A21N",
            category: "A3",
          },
          // GNSS altitude; seen_pos to the whole second.
          fix: [
            ...nztm(ANZ441.lat, ANZ441.lon),
            Math.round(3100 * FEET),
            ago(1),
            180 * KNOTS,
            200,
            (-704 * FEET) / 60,
          ],
        },
        {
          aircraft: expect.objectContaining({ callsign: "QFA163" }),
          // Pressure altitude, corrected by how far ANZ441's is out.
          fix: [
            ...nztm(QFA163.lat, QFA163.lon),
            Math.round(10100 * FEET),
            NOW,
            300 * KNOTS,
            250,
            0,
          ],
        },
        {
          aircraft: expect.objectContaining({ callsign: null }),
          // On the ground.
          fix: [
            ...nztm(TAXIING.lat, TAXIING.lon),
            null,
            ago(3),
            5 * KNOTS,
            90,
            null,
          ],
        },
      ]);
    });

    it("logs what's heard, and stores every airport on each route", async () => {
      const requests = adsb(
        () => HttpResponse.json(airspace([ANZ441, QFA163, TAXIING])),
        () =>
          HttpResponse.json([
            routeReply("ANZ441", ["NSN", "WLG", "AKL"]),
            routeReply("QFA163"),
          ])
      );

      await run((await coldFeed("flights")).poll);

      const [{ data }] = table.records(flights);

      expect(data.sightings.map(({ aircraft }) => aircraft.callsign)).toEqual([
        "ANZ441",
        "QFA163",
        null,
      ]);

      // Not where it was heard: that's in the fix.
      expect(data.sightings[0]).not.toHaveProperty("at");

      expect(await requests.routes[0].json()).toEqual({
        planes: [
          { callsign: "ANZ441", lat: ANZ441.lat, lng: ANZ441.lon },
          { callsign: "QFA163", lat: QFA163.lat, lng: QFA163.lon },
        ],
      });

      const stored = table.records(routes);

      expect(stored.map(({ sk, expires }) => ({ sk, expires }))).toEqual([
        {
          sk: { callsign: "ANZ441", time: NOW },
          expires: NOW / 1000 + 30 * DAY,
        },
        {
          sk: { callsign: "QFA163", time: NOW },
          expires: NOW / 1000 + 30 * DAY,
        },
      ]);

      expect(
        stored[0].data.airports?.map(({ code, elevation }) => [code, elevation])
      ).toEqual([
        ["NSN", 10.36],
        ["WLG", 12.5],
        ["AKL", null],
      ]);

      expect(stored[1].data.airports).toBeNull();
    });

    it("looks up a route again after a day, an unknown one after an hour", async () => {
      const wlg: RouteEnd = {
        code: "WLG",
        at: [1749000, 5427000],
        elevation: 12.5,
      };

      const akl: RouteEnd = {
        code: "AKL",
        at: [1757000, 5720000],
        elevation: null,
      };

      table.seed(
        routes,
        { callsign: "ANZ441", time: ago(23 * 3600) },
        { airports: [akl, wlg] },
        ago(23 * 3600)
      );

      table.seed(
        routes,
        { callsign: "QFA163", time: ago(3700) },
        { airports: null },
        ago(3700)
      );

      const requests = adsb(
        () => HttpResponse.json(airspace([ANZ441, QFA163])),
        () => HttpResponse.json([routeReply("QFA163", ["SYD", "WLG"])])
      );

      const feed = await coldFeed("flights");

      await run(feed.poll);

      expect(await requests.routes[0].json()).toEqual({
        planes: [{ callsign: "QFA163", lat: QFA163.lat, lng: QFA163.lon }],
      });

      // Each looked up from the table once.
      const asked = table.queries.length;

      freezeTime(NOW + 10_000);
      await run(feed.poll);

      expect(requests.routes).toHaveLength(1);
      expect(table.queries).toHaveLength(asked);

      freezeTime(NOW + 3600_000);
      await run(feed.poll);

      expect(await requests.routes[1].json()).toEqual({
        planes: [{ callsign: "ANZ441", lat: ANZ441.lat, lng: ANZ441.lon }],
      });
    });

    it("logs aircraft when routes can't be looked up, and asks again a minute later", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      const requests = adsb(
        () => HttpResponse.json(airspace([ANZ441])),
        () => new HttpResponse(null, { status: 503 })
      );

      const feed = await coldFeed("flights");

      await run(feed.poll);

      expect(table.records(flights)).toHaveLength(1);
      expect(table.records(routes)).toEqual([]);

      freezeTime(NOW + 10_000);
      await run(feed.poll);

      expect(requests.routes).toHaveLength(1);

      freezeTime(NOW + 60_000);
      await run(feed.poll);

      expect(requests.routes).toHaveLength(2);
    });

    it("writes only when an aircraft has a newer fix", async () => {
      let heard = { ...ANZ441, seen_pos: 1 };
      adsb(
        () => HttpResponse.json(airspace([heard])),
        () => HttpResponse.json([routeReply("ANZ441")])
      );

      const feed = await coldFeed("flights");

      await run(feed.poll);

      // Heard again, at the same position: the same fix.
      heard = { ...ANZ441, seen_pos: 1.2 };
      await run(feed.poll);

      expect(table.records(flights)).toHaveLength(1);
    });

    it("logs nothing, and looks nothing up, when adsb.lol turns it away", async () => {
      const requests = adsb(() => new HttpResponse(null, { status: 429 }));

      await expect(run((await coldFeed("flights")).poll)).rejects.toMatchObject(
        {
          cause: { message: expect.stringContaining("HTTP 429") },
        }
      );

      expect(requests.routes).toEqual([]);
      expect(table.items()).toEqual([]);
    });
  });

  describe("vessels", () => {
    const HARBOUR = "https://ais.openwaters.io/v1/vessels";
    const TRACK = "https://ais.openwaters.io/v1/vessels/:mmsi/track";

    const OFF_ORIENTAL_BAY = { lon: 174.7982, lat: -41.2828 };
    const MID_HARBOUR = { lon: 174.8287, lat: -41.2805 };
    const QUEENS_WHARF = { lon: 174.7808, lat: -41.2814 };

    const iso = (time: number) => new Date(time).toISOString();

    const ship = (
      mmsi: number,
      { lon, lat }: { lon: number; lat: number },
      properties: Record<string, number | string>
    ) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { mmsi, kind: "vessel", seen: iso(ago(20)), ...properties },
    });

    const ferry = ship(512003410, OFF_ORIENTAL_BAY, {
      name: "COBAR CAT",
      type: 60,
      sog: 16.7,
      cog: 253.6,
    });

    const moored = ship(512008749, QUEENS_WHARF, { name: "TUG", sog: 0 });

    let trackFrom: string[];

    beforeEach(() => {
      trackFrom = [];

      server.use(
        http.get(HARBOUR, () =>
          HttpResponse.json({ features: [ferry, moored] })
        ),
        http.get(TRACK, ({ request }) => {
          trackFrom.push(new URL(request.url).searchParams.get("from") ?? "");

          const points = [
            { at: MID_HARBOUR, time: ago(40) },
            { at: OFF_ORIENTAL_BAY, time: ago(25) },
          ];

          return HttpResponse.json({
            geometry: {
              type: "LineString",
              coordinates: points.map(({ at: { lon, lat } }) => [lon, lat]),
            },
            properties: {
              times: points.map(({ time }) => iso(time)),
              sog: points.map(() => 16.7),
              cog: points.map(() => 253.6),
              heading: points.map(() => null),
            },
          });
        })
      );
    });

    it("logs the harbour, with the track of each ship under way", async () => {
      table.seed(headings, 512008749, { heading: 120 }, ago(3600));

      await run((await coldFeed("vessels")).poll);

      const [{ data }] = table.records(vessels);

      expect(data.vessels).toEqual([
        {
          mmsi: 512003410,
          name: "COBAR CAT",
          type: 60,
          position: at(OFF_ORIENTAL_BAY),
          speed: 16.7 * KNOTS,
          course: 253.6,
          heading: null,
          dimension: null,
          time: ago(25),
          trail: [
            [...at(MID_HARBOUR), ago(40)],
            [...at(OFF_ORIENTAL_BAY), ago(25)],
          ],
        },
        expect.objectContaining({
          mmsi: 512008749,
          // As it last pointed.
          heading: 120,
          trail: [],
        }),
      ]);

      // The whole trail's worth.
      expect(trackFrom).toEqual([iso(NOW - 15 * 60_000)]);
    });

    it("fetches tracks from where trails end", async () => {
      const feed = await coldFeed("vessels");

      await run(feed.poll);
      freezeTime(NOW + 60_000);
      await run(feed.poll);

      expect(trackFrom[1]).toBe(iso(ago(25)));

      // Already logged: nothing new.
      expect(table.records(vessels)[1].data.vessels[0].trail).toEqual([]);
    });

    it("remembers which way ships under way point, as it changes", async () => {
      const feed = await coldFeed("vessels");

      await run(feed.poll);
      freezeTime(NOW + 60_000);
      await run(feed.poll);

      expect(
        table.records(headings).map(({ sk, data, expires }) => ({
          sk,
          data,
          expires,
        }))
      ).toEqual([
        {
          sk: 512003410,
          data: { heading: 254 },
          expires: NOW / 1000 + 7 * DAY,
        },
      ]);

      // Not written again: it hasn't changed.
      expect(table.records(vessels)).toHaveLength(2);
      expect(table.items()).toHaveLength(3);
    });

    it("reads the headings stored, every page of them, when it starts", async () => {
      table = makeTable({ page: 1 });
      table.seed(headings, 1, { heading: 10 }, ago(60));
      table.seed(headings, 512008749, { heading: 120 }, ago(60));

      await run((await coldFeed("vessels")).poll);

      expect(table.records(vessels)[0].data.vessels[1].heading).toBe(120);
    });

    it("fetches a failed track from where the trail ended, the next poll", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const feed = await coldFeed("vessels");

      await run(feed.poll);

      server.use(
        http.get(TRACK, ({ request }) => {
          trackFrom.push(new URL(request.url).searchParams.get("from") ?? "");

          return new HttpResponse(null, { status: 503 });
        })
      );

      freezeTime(NOW + 60_000);
      await run(feed.poll);

      // Logged as listed, without a trail.
      expect(table.records(vessels)[1].data.vessels[0]).toMatchObject({
        position: at(OFF_ORIENTAL_BAY),
        time: ago(20),
        trail: [],
      });

      server.use(
        http.get(TRACK, ({ request }) => {
          trackFrom.push(new URL(request.url).searchParams.get("from") ?? "");

          return HttpResponse.json({
            geometry: null,
            properties: { times: [], sog: [], cog: [], heading: [] },
          });
        })
      );

      freezeTime(NOW + 120_000);
      await run(feed.poll);

      expect(trackFrom).toEqual([
        iso(NOW - 15 * 60_000),
        iso(ago(25)),
        // Again from where the last track it got ended.
        iso(ago(25)),
      ]);
    });

    it("logs nothing when Open Waters fails", async () => {
      server.use(
        http.get(HARBOUR, () => new HttpResponse(null, { status: 502 }))
      );

      await expect(run((await coldFeed("vessels")).poll)).rejects.toMatchObject(
        {
          cause: { message: expect.stringContaining("HTTP 502") },
        }
      );

      expect(table.items()).toEqual([]);
    });
  });

  it("logs traffic every poll, changed or not", async () => {
    server.use(
      http.get(
        "http://trafficnz.info/service/traffic/rest/4/journeys/byregion/9/1",
        () =>
          HttpResponse.json({
            response: {
              journey: [
                {
                  name: "SH1",
                  legs: [
                    {
                      direction: "I",
                      sequenceNumber: 10,
                      speed: 74.33,
                      coverage: 1,
                      lengths: {
                        linkName: "Ngauranga To Aotea",
                        linkLength: 2.1,
                        linkSpeed: 81,
                      },
                    },
                  ],
                },
              ],
            },
          })
      )
    );

    const feed = await coldFeed("traffic");

    const speeds = {
      links: { "Ngauranga To Aotea|2.1": 81 },
      legs: { "SH1 I 10": 74 },
    };

    await run(feed.poll);
    freezeTime(NOW + 60_000);
    await run(feed.poll);

    expect(
      table.records(traffic).map(({ sk, data }) => ({ sk, data }))
    ).toEqual([
      { sk: NOW, data: speeds },
      { sk: NOW + 60_000, data: speeds },
    ]);
  });

  it("logs no traffic when NZTA fails, keeping the last speeds", async () => {
    table.seed(
      traffic,
      ago(60),
      { links: { "Ngauranga To Aotea|2.1": 81 }, legs: {} },
      ago(60)
    );

    server.use(
      http.get(
        "http://trafficnz.info/service/traffic/rest/4/journeys/byregion/9/1",
        () => new HttpResponse(null, { status: 504 })
      )
    );

    await expect(run((await coldFeed("traffic")).poll)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("nzta: 504") },
    });

    expect(table.records(traffic).map(({ sk }) => sk)).toEqual([ago(60)]);
  });

  describe("weather", () => {
    let asked: number;
    let request: Request | undefined;

    beforeEach(() => {
      asked = 0;

      const variable = (value: number) => ({ data: [value] });

      server.use(
        http.post("https://forecast-v2.metoceanapi.com/point/time", (info) => {
          asked++;
          request = info.request;

          return HttpResponse.json({
            variables: {
              "cloud.cover": variable(39),
              "wind.speed.at-10m": variable(10.2),
            },
          });
        })
      );
    });

    it("logs MetService's conditions every half hour", async () => {
      const feed = await coldFeed("weather");

      await run(feed.poll);

      // For the start of the hour, with the key.
      expect(request?.headers.get("x-api-key")).toBe("metservice-key");

      expect(await request?.json()).toMatchObject({
        time: { from: "2026-11-02T07:00:00.000Z" },
      });

      expect(table.records(weather)[0].data).toMatchObject({
        time: "2026-11-02T07:00:00.000Z",
        cloudCover: 0.39,
        wind: { speed: 10.2, direction: 340 },
      });

      freezeTime(NOW + 29 * 60_000);
      await run(feed.poll);

      expect(asked).toBe(1);

      freezeTime(NOW + 30 * 60_000);
      await run(feed.poll);

      expect(asked).toBe(2);
      expect(table.records(weather)).toHaveLength(2);
    });

    it("goes by the newest stored when it starts", async () => {
      table.seed(
        weather,
        ago(10 * 60),
        {
          time: "2026-11-02T06:00:00.000Z",
          cloudCover: 0,
          cloudBase: null,
          visibility: 30000,
          humidity: 0.7,
          precipitation: 0,
          wind: { speed: 5, direction: 340 },
          windAloft: { speed: 8, direction: 340 },
        },
        ago(10 * 60)
      );

      await run((await coldFeed("weather")).poll);

      expect(asked).toBe(0);
    });

    it("asks again the next minute when MetService fails, not half an hour on", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      server.use(
        http.post("https://forecast-v2.metoceanapi.com/point/time", () => {
          asked++;

          return new HttpResponse("busy", { status: 503 });
        })
      );

      const feed = await coldFeed("weather");

      await run(feed.poll);
      expect(table.records(weather)).toEqual([]);

      freezeTime(NOW + 60_000);

      server.use(
        http.post("https://forecast-v2.metoceanapi.com/point/time", () => {
          asked++;

          return HttpResponse.json({ variables: {} });
        })
      );

      await run(feed.poll);

      expect(asked).toBe(2);
      expect(table.records(weather).map(({ sk }) => sk)).toEqual([
        NOW + 60_000,
      ]);
    });
  });

  describe("quakes", () => {
    const GEONET = "https://api.geonet.org.nz/quake";

    /** A GeoNet quake, `seconds` ago. */
    const reported = (
      id: string,
      [lon, lat]: [number, number],
      magnitude: number,
      seconds: number,
      quality = "automatic"
    ) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        publicID: id,
        time: new Date(ago(seconds)).toISOString(),
        depth: 20.123,
        magnitude,
        mmi: -1,
        locality: "somewhere",
        quality,
      },
    });

    let features: ReturnType<typeof reported>[];

    beforeEach(() => {
      features = [];

      server.use(
        http.get(GEONET, ({ request }) => {
          expect(new URL(request.url).searchParams.get("MMI")).toBe("-1");

          return HttpResponse.json({ type: "FeatureCollection", features });
        })
      );
    });

    it("logs those on the map, and those further off felt here", async () => {
      features = [
        // Off Paraparaumu, small.
        reported("near", [174.95, -40.9], 1.9, 60),
        // Kaikōura, big enough to feel here.
        reported("kaikoura", [173.02, -42.69], 7.8, 600),
        // Te Araroa: neither.
        reported("far", [177.86, -36.81], 4.5, 30),
        reported("gone", [174.8, -41.3], 3, 30, "deleted"),
      ];

      await run((await coldFeed("quakes")).poll);

      const [{ data }] = table.records(quakes);

      expect(data.quakes.map(({ id }) => id)).toEqual(["kaikoura", "near"]);

      expect(data.quakes[1]).toEqual({
        id: "near",
        time: ago(60),
        position: at({ lat: -40.9, lon: 174.95 }).map(Math.round),
        depth: 20.1,
        magnitude: 1.9,
        locality: "somewhere",
        quality: "automatic",
      });
    });

    it("writes only when GeoNet's list changes", async () => {
      features = [reported("near", [174.95, -40.9], 1.9, 60)];
      const feed = await coldFeed("quakes");

      await run(feed.poll);
      await run(feed.poll);
      expect(table.records(quakes)).toHaveLength(1);

      // Reviewed.
      features = [reported("near", [174.95, -40.9], 2.1, 60, "best")];
      freezeTime(NOW + 60_000);
      await run(feed.poll);
      expect(table.records(quakes)).toHaveLength(2);
    });

    it("logs an empty list the first time, so the site knows it's been asked", async () => {
      await run((await coldFeed("quakes")).poll);

      expect(table.records(quakes).map(({ data }) => data)).toEqual([
        { quakes: [] },
      ]);
    });

    it("logs nothing when GeoNet fails", async () => {
      server.use(
        http.get(GEONET, () => new HttpResponse(null, { status: 500 }))
      );

      await expect(run((await coldFeed("quakes")).poll)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("geonet: HTTP 500") },
      });

      expect(table.items()).toEqual([]);
    });
  });

  describe("tide", () => {
    const SERIES =
      "https://tilde.geonet.org.nz/v4/data/coastal/WLGT/water-height/40/15s/nil/latest/:period";

    let asked: string[];
    let quiet: boolean;

    /** Tilde's minutes: rising 0.6 m an hour, 2.9 m on the gauge now. */
    const minutes = () =>
      Array.from({ length: 30 }, (_, i) => ({
        val: 2.9 - (0.6 * (29 - i)) / 60,
        err: 0,
        qc: "",
        ts: new Date(ago((29 - i) * 60)).toISOString().replace(".000", ""),
      }));

    beforeEach(() => {
      asked = [];
      quiet = false;

      server.use(
        http.get(SERIES, ({ params, request }) => {
          const { searchParams } = new URL(request.url);
          asked.push(
            `${params.period} ${searchParams.get("aggregationPeriod")}`
          );
          expect(searchParams.get("aggregationFunction")).toBe("mean");

          const data =
            params.period === "30d"
              ? [2.5, 2.7].map((val, i) => ({
                  val,
                  err: 0,
                  qc: "",
                  ts: `2026-10-0${i + 1}T00:00:00Z`,
                }))
              : quiet
                ? []
                : minutes();

          return HttpResponse.json([{ data, series: {} }]);
        })
      );
    });

    it("logs the harbour's height above its 30-day mean every five minutes", async () => {
      const feed = await coldFeed("tide");

      await run(feed.poll);

      expect(table.records(tide)[0].data).toEqual({
        time: Date.parse(new Date(NOW).toISOString().slice(0, 19) + "Z"),
        level: 0.3,
        rate: 0.6,
      });

      freezeTime(NOW + 4 * 60_000);
      await run(feed.poll);
      freezeTime(NOW + 5 * 60_000);
      await run(feed.poll);

      expect(table.records(tide)).toHaveLength(2);
      // The mean once, until it's a day old.
      expect(asked).toEqual(["30d 1d", "30m 1m", "30m 1m"]);
    });

    it("logs nothing when the gauge has gone quiet", async () => {
      quiet = true;

      await run((await coldFeed("tide")).poll);

      expect(table.records(tide)).toHaveLength(0);
    });

    it("asks for the mean again once it's a day old", async () => {
      const feed = await coldFeed("tide");

      await run(feed.poll);
      freezeTime(NOW + 23 * 3600_000);
      await run(feed.poll);
      freezeTime(NOW + 24 * 3600_000);
      await run(feed.poll);

      expect(asked).toEqual(["30d 1d", "30m 1m", "30m 1m", "30d 1d", "30m 1m"]);
    });

    it("goes by the last poll stored when it starts", async () => {
      table.seed(
        tide,
        ago(60),
        { time: ago(90), level: 0.2, rate: 0.5 },
        ago(60)
      );

      await run((await coldFeed("tide")).poll);

      expect(asked).toEqual([]);
    });

    it("logs nothing without a mean to measure from, and asks again", async () => {
      server.use(
        http.get(SERIES, () => HttpResponse.json([{ data: [], series: {} }]))
      );

      const feed = await coldFeed("tide");

      await expect(run(feed.poll)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("no days measured") },
      });
      expect(table.items()).toEqual([]);

      server.use(
        http.get(SERIES, ({ params }) =>
          HttpResponse.json([
            {
              series: {},
              data:
                params.period === "30d"
                  ? [{ val: 2.6, ts: "2026-10-01T00:00:00Z" }]
                  : [{ val: 2.8, ts: "2026-11-02T07:00:00Z" }],
            },
          ])
        )
      );

      freezeTime(NOW + 60_000);
      await run(feed.poll);

      expect(table.records(tide)[0].data).toMatchObject({ level: 0.2 });
    });
  });
});

describe("publishing the positions", () => {
  beforeEach(() => {
    table = makeTable();
    bucket = makeBucket();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  /** The feeds and the publisher, as a newly started container has them. */
  async function coldStart() {
    const made = await Effect.runPromise(makeFeeds);

    return { ...made.logs, publish: await Effect.runPromise(publisher(made)) };
  }

  it("publishes every layer, folded as the site serves it, gzipped", async () => {
    let seconds = 40;
    metlink(() => atStation(seconds)());
    const { trains, publish } = await coldStart();

    await run(trains.poll);
    seconds = 10;
    freezeTime(NOW + 10_000);
    await run(trains.poll);
    await run(publish.poll);

    expect(bucket.puts[0]).toMatchObject({
      Key: KEY,
      ContentType: "application/json",
      ContentEncoding: "gzip",
    });

    const station = at(PLACES.wellingtonStation);

    expect(bucket.published()).toEqual({
      v: 1,
      time: NOW + 10_000,
      trains: [
        {
          ...train(10),
          trail: [
            [...station, ago(40)],
            [...station, ago(10)],
          ],
        },
      ],
      buses: [],
      aircraft: [],
      vessels: [],
      traffic: null,
      weather: null,
      quakes: [],
      tide: null,
    });
  });

  it("publishes again only once something's new", async () => {
    metlink(atStation(10));
    const { trains, publish } = await coldStart();

    await run(trains.poll);
    await run(publish.poll);
    await run(trains.poll);
    await run(publish.poll);

    expect(bucket.puts).toHaveLength(1);
  });

  it("publishes what's stored when the container's cold", async () => {
    table.seed(trains, ago(40), { trains: [train(40)] }, ago(40));
    table.seed(trains, ago(10), { trains: [train(10)] }, ago(10));

    // Too old for a trail, but the newest there is.
    const moored = {
      mmsi: 512008749,
      name: "TUG",
      type: 52,
      position: at(PLACES.wellingtonStation),
      speed: 0,
      course: null,
      heading: 120,
      dimension: null,
      time: ago(3 * 3600),
      trail: [],
    };

    table.seed(vessels, ago(3 * 3600), { vessels: [moored] }, ago(3 * 3600));

    table.seed(
      traffic,
      ago(30),
      { links: { "Ngauranga To Aotea|2.1": 81 }, legs: {} },
      ago(30)
    );

    const { publish } = await coldStart();

    await run(publish.poll);

    const published = bucket.published();

    expect(published.trains[0].trail).toHaveLength(2);
    expect(published.vessels).toEqual([moored]);

    expect(published.traffic).toEqual({
      fetched: ago(30),
      links: { "Ngauranga To Aotea|2.1": 81 },
      legs: {},
    });
  });

  it("joins each aircraft to the leg of its route it's flying", async () => {
    adsb(
      () => HttpResponse.json(airspace([ANZ441])),
      () => HttpResponse.json([routeReply("ANZ441", ["AKL", "WLG"])])
    );

    const { flights, publish } = await coldStart();

    await run(flights.poll);
    await run(publish.poll);

    const [aircraft] = bucket.published().aircraft;

    expect(aircraft.route?.from.code).toBe("AKL");
    expect(aircraft.route?.to.code).toBe("WLG");
  });
});

describe("a minute's polling", () => {
  it("polls each feed from its offset, every so often, until 52 s in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const polled: Record<string, number[]> = {};
    const reported: string[] = [];

    const fake = (name: string, every: number, offset: number): Feed => ({
      name,
      every,
      offset,
      poll: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        (polled[name] ??= []).push(now);

        // A failing feed is polled again all the same.
        if (name === "failing") return yield* Effect.fail("down");
      }),
      report: Effect.sync(() => reported.push(name)),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const minute = yield* Effect.forkChild(
          pollMinute([
            fake("trains", 10_000, 3_000),
            fake("failing", 20_000, 5_000),
          ])
        );

        yield* TestClock.adjust("1 minute");
        yield* Fiber.join(minute);
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(LiveTable, makeTable().service),
        Effect.provideService(LiveBucket, makeBucket().service)
      )
    );

    expect(polled).toEqual({
      trains: [3_000, 13_000, 23_000, 33_000, 43_000],
      failing: [5_000, 25_000, 45_000],
    });

    expect(reported.sort()).toEqual(["failing", "trains"]);
  });
});

describe("the timeline counter", () => {
  beforeEach(() => {
    table = makeTable();
    bucket = makeBucket();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  /** The trains feed and the counter, as a newly started container has them. */
  async function coldStart() {
    const made = await Effect.runPromise(makeFeeds);

    return {
      trains: made.logs.trains,
      count: await Effect.runPromise(counter(made)),
    };
  }

  it("adds each minute's count to the hour's item", async () => {
    metlink(atStation(10));
    const { trains, count } = await coldStart();

    await run(trains.poll);
    await run(count.poll);

    // Another container, cold, the next minute: it reads what's there.
    freezeTime(NOW + 60_000);
    await run((await coldStart()).count.poll);

    const [hour] = table.records(timeline);
    const slot = Math.floor((NOW - hourOf(NOW)) / 300_000);

    expect(hour.sk).toBe(hourOf(NOW));
    expect(hour.expires).toBe(Math.floor((NOW + 60_000) / 1000) + 366 * DAY);
    expect(hour.data.counts.trains?.[slot]).toBe(2);
    expect(hour.data.sums.trains?.[slot]).toBe(2);
    // Nothing polled, nothing known.
    expect(hour.data.sums.buses).toBeUndefined();
  });

  it("starts a new item each hour", async () => {
    metlink(atStation(10));
    const { trains, count } = await coldStart();

    await run(trains.poll);
    await run(count.poll);
    freezeTime(hourOf(NOW) + HOUR + 1_000);
    await run(count.poll);

    const hours = table.records(timeline);

    expect(hours.map(({ sk }) => sk)).toEqual([
      hourOf(NOW),
      hourOf(NOW) + HOUR,
    ]);
    // Its fix is stale by then.
    expect(hours[1].data.sums.trains?.[0]).toBe(0);
    expect(hours[1].data.counts.trains?.[0]).toBe(1);
  });
});
