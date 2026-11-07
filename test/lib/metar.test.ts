import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import {
  fetchMetar,
  humidityOf,
  type Observation,
  parseMetar,
  withObserved,
} from "../../src/lib/metar";
import type { Conditions } from "../../src/lib/weather";
import { NOW } from "../clock";
import { server } from "../msw";

// Wellington Airport's METAR from NOAA's Aviation Weather Center, read into
// what the scene's sky goes by, and laid over MetService's forecast while
// it's fresh.

const LATEST = "https://aviationweather.gov/api/data/metar";

const MINUTE = 60_000;

describe("a METAR", () => {
  it("reads each layer's cover and base above sea level, lowest first", () => {
    const observed = parseMetar(
      "METAR NZWN 072230Z AUTO 36017KT 9999 FEW008/// BKN015/// OVC020/// 18/14 Q1013",
      NOW
    );

    // The airport's 12 m up; bases are hundreds of feet above it.
    expect(observed).toEqual({
      time: NOW,
      temperature: 18,
      dewpoint: 14,
      visibility: 10_000,
      clouds: [
        { cover: 1.5 / 8, base: 256 },
        { cover: 0.75, base: 469 },
        { cover: 1, base: 622 },
      ],
      weather: [],
      raw: "METAR NZWN 072230Z AUTO 36017KT 9999 FEW008/// BKN015/// OVC020/// 18/14 Q1013",
    });
  });

  it("reads cold, fog and rain, the visibility in metres", () => {
    const observed = parseMetar(
      "NZWN 080600Z AUTO VRB02KT 0400 R16/0600N FG -RA VV002 M01/M02 Q1030",
      NOW
    );

    expect(observed).toMatchObject({
      temperature: -1,
      dewpoint: -2,
      visibility: 400,
      // Obscured: overcast at the vertical visibility.
      clouds: [{ cover: 1, base: 73 }],
      weather: ["FG", "-RA"],
    });
  });

  it("has no cloud for CAVOK or none detected", () => {
    expect(
      parseMetar("NZWN 290100Z AUTO 33021G35KT 9999 NCD 17/10 Q0994", NOW)
        .clouds
    ).toEqual([]);

    expect(
      parseMetar("NZWN 290100Z 33021KT CAVOK 17/10 Q0994", NOW)
    ).toMatchObject({ visibility: 10_000, clouds: [] });
  });

  it("leaves out what's forecast in the trend, and the remarks", () => {
    const observed = parseMetar(
      "NZWN 290100Z 33021KT 9999 SCT030 17/10 Q0994 TEMPO 3000 SHRA BKN010 RMK FEW050",
      NOW
    );

    expect(observed).toMatchObject({
      visibility: 10_000,
      clouds: [{ cover: 3.5 / 8, base: 926 }],
      weather: [],
    });
  });

  it("counts the cloud under each layer in it", () => {
    // Reported this way, the higher layer's SCT is what it adds alone.
    const observed = parseMetar(
      "NZWN 290100Z AUTO 33021KT 9999 BKN010/// SCT030/// 17/10 Q0994",
      NOW
    );

    expect(observed.clouds.map(({ cover }) => cover)).toEqual([0.75, 0.75]);
  });

  it("leaves out a layer with no base", () => {
    expect(
      parseMetar("NZWN 290100Z AUTO 33021KT 9999 BKN/// 17/10 Q0994", NOW)
        .clouds
    ).toEqual([]);
  });
});

describe("the airport's newest METAR", () => {
  const report = (minutesAgo: number, raw: string) => ({
    obsTime: (NOW - minutesAgo * MINUTE) / 1000,
    rawOb: raw,
  });

  it("is the newest of the last two hours", async () => {
    let asked: URL | null = null;

    server.use(
      http.get(LATEST, ({ request }) => {
        asked = new URL(request.url);

        return HttpResponse.json([
          report(30, "METAR NZWN 020630Z AUTO 36017KT 9999 NCD 15/10 Q1013"),
          report(
            0,
            "METAR NZWN 020700Z AUTO 36017KT 9999 BKN015/// 16/10 Q1013"
          ),
        ]);
      })
    );

    expect(await fetchMetar()).toMatchObject({
      time: NOW - (NOW % 1000),
      temperature: 16,
      clouds: [{ cover: 0.75, base: 469 }],
    });

    expect(asked!.searchParams.get("ids")).toBe("NZWN");
    expect(asked!.searchParams.get("hours")).toBe("2");
  });

  it("is null when there's been none", async () => {
    server.use(http.get(LATEST, () => new HttpResponse(null, { status: 204 })));

    expect(await fetchMetar()).toBeNull();
  });

  it("throws when the server fails", async () => {
    server.use(http.get(LATEST, () => new HttpResponse(null, { status: 502 })));

    await expect(fetchMetar()).rejects.toThrow("metar: HTTP 502");
  });
});

describe("the forecast, with what's observed", () => {
  const forecast: Conditions = {
    time: "2026-11-02T07:00:00.000Z",
    cloudCover: 0.68,
    cloudBase: 339,
    visibility: 30000,
    humidity: 0.7,
    precipitation: 0.4,
    temperature: 16.4,
    wind: { speed: 8, direction: 340 },
    windAloft: { speed: 11, direction: 340 },
  };

  const observed = (minutesAgo: number, raw: string): Observation =>
    parseMetar(raw, NOW - minutesAgo * MINUTE);

  it("goes by the airport for the temperature, air and cloud", () => {
    const metar = observed(
      20,
      "NZWN 020640Z AUTO 36017KT 9999 BKN015/// BKN020/// 18/14 Q1013"
    );

    expect(withObserved(forecast, metar, NOW)).toEqual({
      ...forecast,
      temperature: 18,
      humidity: humidityOf(18, 14),
      visibility: 30000,
      cloudCover: 0.75,
      cloudBase: 469,
      layers: [
        { cover: 0.75, base: 469 },
        { cover: 0.75, base: 622 },
      ],
      observed: NOW - 20 * MINUTE,
    });

    expect(humidityOf(18, 14)).toBeCloseTo(0.77, 2);
  });

  it("keeps the forecast's wind and rain, measured better elsewhere", () => {
    const merged = withObserved(
      forecast,
      observed(5, "NZWN 020655Z AUTO 18030KT 9999 OVC008/// 12/11 Q1013"),
      NOW
    );

    expect(merged).toMatchObject({
      wind: forecast.wind,
      windAloft: forecast.windAloft,
      precipitation: 0.4,
    });
  });

  it("takes a visibility under ten kilometres as it is", () => {
    const merged = withObserved(
      forecast,
      observed(5, "NZWN 020655Z AUTO 18010KT 3000 BR OVC003/// 12/12 Q1013"),
      NOW
    );

    expect(merged.visibility).toBe(3000);
    expect(merged.humidity).toBe(1);
  });

  it("lets through only a little of the forecast's cover when none's seen", () => {
    const merged = withObserved(
      forecast,
      observed(5, "NZWN 020655Z AUTO 18010KT 9999 NCD 12/02 Q1013"),
      NOW
    );

    expect(merged).toMatchObject({
      cloudCover: 0.2,
      cloudBase: null,
      layers: [],
    });
  });

  it("is the forecast once the observation's over 75 minutes old", () => {
    const old = observed(
      76,
      "NZWN 020545Z AUTO 18010KT 9999 OVC008 12/02 Q1013"
    );

    expect(withObserved(forecast, old, NOW)).toBe(forecast);
    expect(withObserved(forecast, null, NOW)).toBe(forecast);
  });
});
