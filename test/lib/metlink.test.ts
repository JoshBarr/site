import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBuses, fetchTrains } from "../../src/lib/metlink";
import { toNztm } from "../../src/lib/nztm";
import { ago, freezeTime } from "../clock";
import { answer, metlink, PLACES } from "../fixtures/metlink";
import { server } from "../msw";

// Metlink's vehicle positions, read into the trains and buses the poller
// logs.

/** NZTM to the decimetre, as vehicles are placed. */
function at({ lat, lon }: { lat: number; lon: number }): [number, number] {
  const [easting, northing] = toNztm(lat, lon);

  return [Math.round(easting * 10) / 10, Math.round(northing * 10) / 10];
}

describe("Metlink's vehicle positions", () => {
  beforeEach(() => {
    freezeTime();
    vi.stubEnv("METLINK_API_KEY", "metlink-key");
  });

  it("asks with the key, for JSON", async () => {
    const requests = metlink(answer([]));

    await fetchTrains();

    expect(requests[0].headers.get("x-api-key")).toBe("metlink-key");
    expect(requests[0].headers.get("accept")).toBe("application/json");
  });

  it("names each rail line by its route", async () => {
    const lines = [2, 3, 4, 5, 6].map((route) => ({
      id: `T${route}`,
      ...PLACES.wellingtonStation,
      time: ago(10),
      trip: { route, direction: 1 },
    }));

    metlink(answer(lines));

    expect((await fetchTrains()).map(({ id, line }) => [id, line])).toEqual([
      ["T2", "KPL"],
      ["T3", "MEL"],
      ["T4", "WRL"],
      ["T5", "HVL"],
      ["T6", "JVL"],
    ]);
  });

  it("places a train in NZTM, with its own fix as its trail", async () => {
    metlink(
      answer([
        {
          id: 4245,
          ...PLACES.petone,
          bearing: 200,
          time: ago(12),
          trip: { route: "5", direction: 1 },
        },
      ])
    );

    expect(await fetchTrains()).toEqual([
      {
        // A number from Metlink, a string here.
        id: "4245",
        line: "HVL",
        direction: 1,
        position: at(PLACES.petone),
        bearing: 200,
        time: ago(12),
        trail: [[...at(PLACES.petone), ago(12)]],
      },
    ]);
  });

  it("reads routes as numbers or strings, leaving out trains and others", async () => {
    metlink(
      answer([
        {
          id: "B1",
          ...PLACES.lambtonQuay,
          time: ago(5),
          trip: { route: 14, direction: 0 },
        },
        {
          id: "B2",
          ...PLACES.lambtonQuay,
          time: ago(5),
          trip: { route: "83", direction: 1 },
        },
        // A train, the Days Bay ferry and the cable car.
        {
          id: "T1",
          ...PLACES.lambtonQuay,
          time: ago(5),
          trip: { route: 2, direction: 0 },
        },
        {
          id: "F1",
          ...PLACES.lambtonQuay,
          time: ago(5),
          trip: { route: 8, direction: 0 },
        },
        {
          id: "C1",
          ...PLACES.lambtonQuay,
          time: ago(5),
          trip: { route: "9", direction: 0 },
        },
        // Out of service.
        { id: "B3", ...PLACES.lambtonQuay, time: ago(5) },
      ])
    );

    expect((await fetchBuses()).map(({ id, route }) => [id, route])).toEqual([
      ["B1", "14"],
      ["B2", "83"],
    ]);
  });

  it("goes without a bearing, and a direction, when they're not sent", async () => {
    server.use(
      http.get(
        "https://api.opendata.metlink.org.nz/v1/gtfs-rt/vehiclepositions",
        () =>
          HttpResponse.json({
            entity: [
              {
                vehicle: {
                  position: { latitude: -41.2795, longitude: 174.7765 },
                  timestamp: ago(30) / 1000,
                  trip: { route_id: 40 },
                  vehicle: { id: "2158" },
                },
              },
            ],
          })
      )
    );

    expect(await fetchBuses()).toMatchObject([
      { id: "2158", bearing: null, direction: 0, time: ago(30) },
    ]);
  });

  describe("fails", () => {
    it("without a key, asking nothing", async () => {
      vi.stubEnv("METLINK_API_KEY", "");
      const requests = metlink(answer([]));

      await expect(fetchBuses()).rejects.toThrow("METLINK_API_KEY isn't set");
      expect(requests).toEqual([]);
    });

    it("when Metlink does, naming the status", async () => {
      metlink(() => new HttpResponse(null, { status: 503 }));

      await expect(fetchTrains()).rejects.toThrow("HTTP 503");
    });

    it("when it answers with something else", async () => {
      metlink(() => HttpResponse.json({ entity: [{ vehicle: {} }] }));

      await expect(fetchBuses()).rejects.toThrow(
        "metlink vehiclepositions: unexpected response"
      );
    });
  });
});
