import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConditions } from "../../src/lib/weather";
import { freezeTime } from "../clock";
import { server } from "../msw";

// MetService's point forecast for the hour, read into the conditions the
// scene's sky, sea and clouds go by. It never throws: without conditions,
// the poller asks again the next minute.

const POINT = "https://forecast-v2.metoceanapi.com/point/time";

/** MetService answering with a value for each of `values`. */
function metservice(values: Record<string, number | null>) {
  const requests: Request[] = [];

  server.use(
    http.post(POINT, ({ request }) => {
      requests.push(request);

      return HttpResponse.json({
        dimensions: {},
        variables: Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            { data: [value], noData: [value === null ? 1 : 0] },
          ])
        ),
      });
    })
  );

  return requests;
}

describe("MetService's conditions", () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    freezeTime(Date.parse("2026-11-02T07:42:10Z"));
    vi.stubEnv("METSERVICE_API_KEY", "metservice-key");
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("asks for the hour nearest over the CBD, with the key", async () => {
    const requests = metservice({});

    await getConditions();

    const [request] = requests;

    expect(request.headers.get("x-api-key")).toBe("metservice-key");

    expect(await request.json()).toMatchObject({
      points: [{ lon: 174.7787, lat: -41.276825 }],
      time: { from: "2026-11-02T08:00:00.000Z", interval: "1h", repeat: 0 },
      variables: expect.arrayContaining([
        "cloud.cover",
        "air.temperature.at-2m",
        "wind.direction.at-100m",
      ]),
    });
  });

  it("reads them in the scene's units", async () => {
    metservice({
      "cloud.cover": 62.5,
      "cloud.base.height": 840,
      "air.visibility": 12000,
      "air.humidity.at-2m": 91,
      "precipitation.rate": 1.2,
      "air.temperature.at-2m": 288.15,
      "wind.speed.at-10m": 12.4,
      "wind.direction.at-10m": 335,
      "wind.speed.at-100m": 17.8,
      "wind.direction.at-100m": 330,
    });

    expect(await getConditions()).toEqual({
      time: "2026-11-02T08:00:00.000Z",
      cloudCover: 0.625,
      cloudBase: 840,
      visibility: 12000,
      humidity: 0.91,
      precipitation: 1.2,
      temperature: expect.closeTo(15, 10),
      wind: { speed: 12.4, direction: 335 },
      windAloft: { speed: 17.8, direction: 330 },
    });
  });

  it("fills in a fair northerly for what it doesn't say", async () => {
    metservice({ "cloud.cover": null, "air.temperature.at-2m": null });

    expect(await getConditions()).toEqual({
      time: "2026-11-02T08:00:00.000Z",
      cloudCover: 0,
      cloudBase: null,
      visibility: 30000,
      humidity: 0.7,
      precipitation: 0,
      temperature: null,
      wind: { speed: 5, direction: 340 },
      windAloft: { speed: 8, direction: 340 },
    });
  });

  describe("are null, saying why,", () => {
    it("without a key, asking nothing", async () => {
      vi.stubEnv("METSERVICE_API_KEY", "");
      const requests = metservice({});

      expect(await getConditions()).toBeNull();
      expect(requests).toEqual([]);
      expect(errors).toHaveBeenCalledWith(
        "[weather] missing METSERVICE_API_KEY"
      );
    });

    it("when MetService fails", async () => {
      server.use(
        http.post(
          POINT,
          () => new HttpResponse("quota exceeded", { status: 429 })
        )
      );

      expect(await getConditions()).toBeNull();
      expect(errors).toHaveBeenCalledWith(
        "[weather] HTTP 429:",
        "quota exceeded"
      );
    });

    it("when it can't be reached", async () => {
      server.use(http.post(POINT, () => HttpResponse.error()));

      expect(await getConditions()).toBeNull();
      expect(errors).toHaveBeenCalledWith("[weather]", expect.any(TypeError));
    });

    it("when it answers with something else", async () => {
      server.use(http.post(POINT, () => HttpResponse.json({ variables: [] })));

      expect(await getConditions()).toBeNull();

      expect(errors).toHaveBeenCalledWith(
        "[weather]",
        expect.objectContaining({
          message: expect.stringContaining("metservice: unexpected response"),
        })
      );
    });
  });
});
