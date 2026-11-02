import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../../src/pages/api/weather";
import { freezeTime } from "../clock";
import { server } from "../msw";
import { call } from "../next";

const METSERVICE = "https://forecast-v2.metoceanapi.com/point/time";

/** A variable as MetService sends it, with one value. */
const variable = (value: number | null) => ({
  standardName: "test",
  units: "test",
  dimensions: ["time", "point"],
  data: [value],
  noData: [value === null ? 2 : 0],
});

/** MetService's answer for one point at one time, trimmed. */
const forecast = {
  dimensions: {
    point: {
      type: "point",
      units: "unknown",
      data: [{ lon: 174.7787, lat: -41.276825 }],
    },
    time: { type: "time", units: "unknown", data: ["2026-11-02T07:00:00Z"] },
  },
  noDataReasons: { GOOD: 0, FILL: 2 },
  variables: {
    "air.humidity.at-2m": variable(87),
    "air.visibility": variable(29801.79),
    "cloud.base.height": variable(1361.055),
    "cloud.cover": variable(39),
    "precipitation.rate": variable(0.5),
    "wind.direction.at-100m": variable(327.1),
    "wind.direction.at-10m": variable(329),
    "wind.speed.at-100m": variable(15.4),
    "wind.speed.at-10m": variable(10.2),
  },
};

describe("/api/weather", () => {
  const requests: Request[] = [];

  beforeEach(() => {
    requests.length = 0;
    freezeTime(Date.parse("2026-11-02T07:42:10Z"));
  });

  const metservice = (respond: () => Response) =>
    server.use(
      http.post(METSERVICE, ({ request }) => {
        requests.push(request.clone());

        return respond();
      })
    );

  it("serves this hour's conditions from MetService", async () => {
    metservice(() => HttpResponse.json(forecast));

    const response = await call(route);

    expect(response.status).toBe(200);

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=1800, stale-while-revalidate=3600"
    );

    expect(await response.json()).toEqual({
      time: "2026-11-02T07:00:00.000Z",
      cloudCover: 0.39,
      cloudBase: 1361.055,
      visibility: 29801.79,
      humidity: 0.87,
      precipitation: 0.5,
      wind: { speed: 10.2, direction: 329 },
      windAloft: { speed: 15.4, direction: 327.1 },
    });
  });

  it("asks for the start of the hour, with the API key", async () => {
    metservice(() => HttpResponse.json(forecast));

    await call(route);

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("x-api-key")).toBe("metservice-key");

    expect(await requests[0].json()).toMatchObject({
      points: [{ lon: 174.7787, lat: -41.276825 }],
      time: { from: "2026-11-02T07:00:00.000Z", interval: "1h", repeat: 0 },
    });
  });

  it("fills in what MetService has no value for", async () => {
    metservice(() =>
      HttpResponse.json({
        variables: {
          "cloud.cover": variable(null),
          "cloud.base.height": variable(null),
        },
      })
    );

    const response = await call(route);

    expect(await response.json()).toEqual({
      time: "2026-11-02T07:00:00.000Z",
      cloudCover: 0,
      cloudBase: null,
      visibility: 30000,
      humidity: 0.7,
      precipitation: 0,
      wind: { speed: 5, direction: 340 },
      windAloft: { speed: 8, direction: 340 },
    });
  });

  it("is unavailable, briefly cached, when MetService fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    metservice(() => HttpResponse.json({ message: "nope" }, { status: 503 }));

    const response = await call(route);

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=60");
    expect(await response.json()).toEqual({ error: "weather unavailable" });
  });

  it("is unavailable when MetService's answer isn't as expected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    metservice(() =>
      HttpResponse.json({ variables: { "cloud.cover": { data: "39" } } })
    );

    const response = await call(route);

    expect(response.status).toBe(502);
  });

  it("is unavailable without an API key, and doesn't ask", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("METSERVICE_API_KEY", "");
    metservice(() => HttpResponse.json(forecast));

    const response = await call(route);

    expect(response.status).toBe(502);
    expect(requests).toHaveLength(0);
  });
});
