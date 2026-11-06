import { readFileSync } from "node:fs";
import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { fetchWind, STATIONS } from "../../src/lib/windStations";
import { NOW } from "../clock";
import { server } from "../msw";

// GWRC's weather stations through Hilltop: each station's speed and
// direction asked for separately, read into a ten-minute mean at each.

const SERVER = "https://hilltop.gw.govt.nz/data.hts";

/** `minutes` before NOW, as Hilltop writes it: NZST, without saying so. */
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000 + 12 * 3600_000).toISOString().slice(0, 19);

/** A series of (minutes ago, value) readings, as GetData answers. */
const series = (site: string, name: string, readings: [number, number][]) =>
  `<?xml version="1.0" ?>
<Hilltop>
<Agency>GWRC</Agency>
<Measurement SiteName="${site}">
<DataSource Name="${name}" NumItems="1">
<TSType>StdSeries</TSType>
<ItemInfo ItemNumber="1"><ItemName>${name}</ItemName><Units>m/s</Units></ItemInfo>
</DataSource>
<Data DateFormat="Calendar" NumItems="1">
${readings.map(([m, v]) => `<E><T>${minutesAgo(m)}</T><I1>${v}</I1></E>`).join("\n")}
</Data>
</Measurement>
</Hilltop>`;

type Readings = Record<
  string,
  { speed: [number, number][]; direction: [number, number][] }
>;

/** Hilltop answering from `readings`, by site; "no data" for the rest. */
function hilltop(readings: Readings) {
  const asked: string[] = [];

  server.use(
    http.get(SERVER, ({ request }) => {
      const { search, searchParams } = new URL(request.url);
      const site = searchParams.get("Site") ?? "";
      const measurement = searchParams.get("Measurement") ?? "";
      const station = STATIONS.find((s) => s.site === site);
      asked.push(search);

      if (!station || !readings[site]) {
        return new HttpResponse(
          `<Hilltop><Error>No data for ${measurement} at ${site}</Error></Hilltop>`
        );
      }

      const which = measurement === station.speed ? "speed" : "direction";

      return new HttpResponse(series(site, measurement, readings[site][which]));
    })
  );

  return asked;
}

describe("the weather stations", () => {
  it("each read as the mean wind over the ten minutes to its newest", async () => {
    const asked = hilltop({
      // A northerly, then a westerly: their mean's a north-westerly. The
      // reading 15 minutes before the newest is before the ten minutes.
      "Karori Stream at Samuel Marsden School": {
        speed: [
          [17, 20],
          [6, 4],
          [2, 4],
        ],
        direction: [
          [17, 180],
          [6, 0],
          [2, 270],
        ],
      },
    });

    const { time, stations } = await fetchWind(NOW);

    expect(time).toBe(NOW);
    expect(stations).toHaveLength(1);
    expect(stations[0]).toMatchObject({
      site: "Karori Stream at Samuel Marsden School",
      direction: 315,
      at: NOW - 2 * 60_000,
    });
    expect(stations[0].speed).toBeCloseTo(4 * Math.SQRT1_2, 2);

    expect(asked).toContain(
      "?Service=Hilltop&Request=GetData&Site=Karori%20Stream%20at%20Samuel%20Marsden%20School&Measurement=Wind%20Speed&TimeInterval=PT75M%2Fnow"
    );
    // Every station's speed and direction.
    expect(asked).toHaveLength(STATIONS.length * 2);
  });

  it("are in m/s, the fire weather stations' from km/h", async () => {
    hilltop({
      "NRFA at Belmont": { speed: [[10, 36]], direction: [[10, 300]] },
    });

    const { stations } = await fetchWind(NOW);

    expect(stations).toEqual([
      {
        site: "NRFA at Belmont",
        speed: 10,
        direction: 300,
        at: NOW - 10 * 60_000,
      },
    ]);
  });

  it("leave out those quiet over an hour, and faults", async () => {
    hilltop({
      "Birch Lane AQ": { speed: [[80, 3]], direction: [[80, 0]] },
      // Karori sometimes reads 200 m/s.
      "Karori Stream at Samuel Marsden School": {
        speed: [
          [3, 200],
          [2, 3],
        ],
        direction: [
          [3, 0],
          [2, 90],
        ],
      },
    });

    const { stations } = await fetchWind(NOW);

    expect(stations).toEqual([
      {
        site: "Karori Stream at Samuel Marsden School",
        speed: 3,
        direction: 90,
        at: NOW - 2 * 60_000,
      },
    ]);
  });

  it("go on without those that fail", async () => {
    server.use(http.get(SERVER, () => new HttpResponse(null, { status: 503 })));

    expect(await fetchWind(NOW)).toEqual({ time: NOW, stations: [] });
  });

  it("are those the scene knows how to read (build_stations.py)", () => {
    // SAFETY: what build_stations.py writes; were it otherwise, this test
    // fails on comparing it.
    const calibrated = JSON.parse(
      readFileSync("public/wind/stations.json", "utf8")
    ) as {
      stations: {
        site: string;
        speed: string;
        direction: string;
        scale: number;
      }[];
    };

    expect(
      calibrated.stations.map(({ site, speed, direction, scale }) => ({
        site,
        speed,
        direction,
        scale,
      }))
    ).toEqual(
      STATIONS.map(({ site, speed, direction, scale }) => ({
        site,
        speed,
        direction,
        scale: Math.round(scale * 1e6) / 1e6,
      }))
    );
  });
});
