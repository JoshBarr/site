import { HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toNztm } from "../../src/lib/nztm";
import * as route from "../../src/pages/api/trains";
import { ago, freezeTime, NOW } from "../clock";
import { answer, metlink, PLACES } from "../fixtures/metlink";
import { call } from "../next";
import { redis } from "../redis";

/** NZTM to the decimetre, as trains are placed. */
function at({ lat, lon }: { lat: number; lon: number }): [number, number] {
  const [easting, northing] = toNztm(lat, lon);

  return [Math.round(easting * 10) / 10, Math.round(northing * 10) / 10];
}

const station = at(PLACES.wellingtonStation);
const petone = at(PLACES.petone);

describe("/api/trains", () => {
  beforeEach(() => freezeTime());

  it("serves the trains in service, by line, from Metlink", async () => {
    metlink(
      answer([
        {
          id: "FP4123",
          ...PLACES.wellingtonStation,
          bearing: 15,
          time: ago(10),
          trip: { route: 2, direction: 0 },
        },
        {
          id: 4245,
          ...PLACES.petone,
          time: ago(12),
          trip: { route: 5, direction: 1 },
        },
        // A bus.
        {
          id: "2158",
          ...PLACES.lambtonQuay,
          time: ago(10),
          trip: { route: 40, direction: 0 },
        },
        // Out to Masterton, off the map.
        {
          id: "SW1",
          ...PLACES.masterton,
          time: ago(10),
          trip: { route: 4, direction: 0 },
        },
      ])
    );

    const response = await call(route);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({
      time: NOW,
      trains: [
        {
          id: "FP4123",
          line: "KPL",
          direction: 0,
          position: station,
          bearing: 15,
          time: ago(10),
          trail: [[...station, ago(10)]],
        },
        {
          id: "4245",
          line: "HVL",
          direction: 1,
          position: petone,
          bearing: null,
          time: ago(12),
          trail: [[...petone, ago(12)]],
        },
      ],
    });
  });

  it("carries a train's trail on, whichever way it's going", async () => {
    redis.seed("trains:snapshot", {
      time: ago(30),
      trains: [
        {
          id: "FP4123",
          line: "HVL",
          direction: 1,
          position: petone,
          bearing: 200,
          time: ago(40),
          trail: [[...petone, ago(40)]],
        },
      ],
    });

    metlink(
      answer([
        {
          id: "FP4123",
          ...PLACES.wellingtonStation,
          bearing: 200,
          time: ago(5),
          trip: { route: 5, direction: 0 },
        },
      ])
    );

    const response = await call(route);
    const { trains } = await response.json();

    expect(trains[0].trail).toEqual([
      [...petone, ago(40)],
      [...station, ago(5)],
    ]);
  });

  it("serves no trains when Metlink fails and none are stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    metlink(() => new HttpResponse(null, { status: 503 }));

    const response = await call(route);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ time: NOW, trains: [] });
  });

  it("is unavailable when Metlink fails, without Redis", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    metlink(() => new HttpResponse(null, { status: 503 }));

    const response = await call(route);

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
    expect(await response.json()).toEqual({ error: "trains unavailable" });
  });
});
