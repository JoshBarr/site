import { readFileSync } from "node:fs";
import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { fetchRadar, rateOf } from "../../src/lib/radar";
import {
  byteRate,
  RADAR_SIZE,
  RADAR_SPAN,
  rateByte,
  toRadar,
} from "../../src/lib/radarGrid";
import { toNztm } from "../../src/lib/nztm";
import { encodePng } from "../fixtures/png";
import { server } from "../msw";

// The rain radar through RainViewer: its newest frame's picture, centred on
// the map, read by its colours onto a 128² grid a kilometre a cell, twice
// the terrain's root across.

const FRAMES = "https://api.rainviewer.com/public/weather-maps.json";
const HOST = "https://tilecache.rainviewer.com";

/** The picture's size, and the map's centre as it's asked for. */
const IMAGE = 512;
const CENTRE = { lat: -41.2859, lon: 174.7674 };

/** RainViewer's colours for 30 dBZ (2.7 mm/h) and 45 (24 mm/h), opaque. */
const BLUE = [0x00, 0x55, 0x88, 255];
const RED = [0xff, 0x44, 0x00, 255];

/** And for 5 dBZ: a haze, too faint to be rain. */
const HAZE = [0x92, 0x88, 0x71, 0x64];

const CLEAR = [0, 0, 0, 0];

/** Pictures as RainViewer serves them, captured 2026-11-20. */
const captured = (name: string) =>
  readFileSync(new URL(`../fixtures/rainviewer/${name}`, import.meta.url));

/** A picture of what `paint` gives each pixel. */
const picture = (paint: (x: number, y: number) => number[]) => {
  const pixels = new Uint8Array(IMAGE * IMAGE * 4);

  for (let y = 0; y < IMAGE; y++) {
    for (let x = 0; x < IMAGE; x++) {
      pixels.set(paint(x, y), (y * IMAGE + x) * 4);
    }
  }

  return encodePng(IMAGE, IMAGE, pixels, { type: 6 });
};

/** Where latitude and longitude fall in the picture, pixels. */
function pixelOf(lat: number, lon: number) {
  const across = IMAGE * 2 ** 7;

  const on = (at: { lat: number; lon: number }) => [
    ((at.lon + 180) / 360) * across,
    ((1 - Math.asinh(Math.tan((at.lat * Math.PI) / 180)) / Math.PI) / 2) *
      across,
  ];

  const [x, y] = on({ lat, lon });
  const [cx, cy] = on(CENTRE);

  return [x - cx + IMAGE / 2, y - cy + IMAGE / 2];
}

/** The grid's cell over latitude and longitude: column, row. */
function cellOf(lat: number, lon: number) {
  const [easting, northing] = toNztm(lat, lon);
  const cell = RADAR_SPAN / RADAR_SIZE;

  return [
    Math.floor((easting - 1748000 + RADAR_SPAN / 2) / cell),
    Math.floor((5428000 - northing + RADAR_SPAN / 2) / cell),
  ];
}

describe("the rain radar", () => {
  let asked: string[];

  /** RainViewer with frames at `times` (epoch s), each one's picture `png`. */
  function rainviewer(times: number[], png: Uint8Array, host = HOST) {
    asked = [];

    server.use(
      http.get(FRAMES, () =>
        HttpResponse.json({
          version: "2.0",
          generated: Math.max(...times) + 300,
          host,
          radar: {
            past: times.map((time) => ({ time, path: `/v2/radar/${time}` })),
            nowcast: [],
          },
          satellite: { infrared: [] },
        })
      ),
      http.get(`${HOST}/v2/radar/*`, ({ request }) => {
        asked.push(new URL(request.url).pathname);

        return new HttpResponse(png, {
          headers: { "Content-Type": "image/png" },
        });
      })
    );
  }

  const cellsOf = (cells: string) => Buffer.from(cells, "base64");

  it("turns reflectivity into rain by Marshall and Palmer, less the faint", () => {
    expect(rateOf(14)).toBe(0);
    expect(rateOf(15)).toBeCloseTo(0.32, 2);
    expect(rateOf(30)).toBeCloseTo(2.73, 2);
    expect(rateOf(45)).toBeCloseTo(23.7, 1);

    // Past 55 it's hail.
    expect(rateOf(70)).toBeCloseTo(rateOf(55), 5);
    expect(rateOf(55)).toBeCloseTo(100, 0);
  });

  it("keeps a rate through a cell's byte, drizzle too", () => {
    expect(rateByte(0)).toBe(0);
    expect(byteRate(rateByte(0.3))).toBeCloseTo(0.3, 1);
    expect(byteRate(rateByte(4))).toBeCloseTo(4, 1);
    expect(byteRate(rateByte(250))).toBe(100);
  });

  it("asks for the newest frame's picture, centred on the map", async () => {
    rainviewer(
      [1795156800, 1795157400],
      picture(() => CLEAR)
    );

    const scan = await fetchRadar();

    expect(scan?.time).toBe(1795157400_000);

    expect(asked).toEqual([
      "/v2/radar/1795157400/512/7/-41.2859/174.7674/2/0_0.png",
    ]);

    // Dry everywhere.
    expect(cellsOf(scan!.cells)).toEqual(Buffer.alloc(RADAR_SIZE * RADAR_SIZE));
  });

  it("puts rain west of the map's centre in the grid's west", async () => {
    rainviewer(
      [1795157400],
      picture((x) => (x < IMAGE / 2 ? BLUE : CLEAR))
    );

    const cells = cellsOf((await fetchRadar())!.cells);
    const row = [...cells.subarray(64 * RADAR_SIZE, 65 * RADAR_SIZE)];

    expect(row.slice(0, 62)).toEqual(Array(62).fill(rateByte(rateOf(30))));
    expect(row.slice(66)).toEqual(Array(RADAR_SIZE - 66).fill(0));
  });

  it("puts rain north of it in the rows from the top", async () => {
    rainviewer(
      [1795157400],
      picture((_, y) => (y < IMAGE / 2 ? RED : CLEAR))
    );

    const cells = cellsOf((await fetchRadar())!.cells);

    const column = Array.from(
      { length: RADAR_SIZE },
      (_, j) => cells[j * RADAR_SIZE + 64]
    );

    expect(column.slice(0, 62)).toEqual(Array(62).fill(rateByte(rateOf(45))));
    expect(column.slice(66)).toEqual(Array(RADAR_SIZE - 66).fill(0));
  });

  it("puts a shower over a place in that place's cell", async () => {
    // Over Upper Hutt, and over Cape Palliser, off the map but on the grid.
    const places = [
      { lat: -41.124, lon: 175.07 },
      { lat: -41.613, lon: 175.29 },
    ];

    const showers = places.map(({ lat, lon }) => pixelOf(lat, lon));

    rainviewer(
      [1795157400],
      picture((x, y) =>
        showers.some(([sx, sy]) => Math.hypot(x + 0.5 - sx, y + 0.5 - sy) < 3.5)
          ? RED
          : CLEAR
      )
    );

    const cells = cellsOf((await fetchRadar())!.cells);

    for (const { lat, lon } of places) {
      const [column, row] = cellOf(lat, lon);

      expect(cells[row * RADAR_SIZE + column]).toBe(rateByte(rateOf(45)));
    }

    // Two showers 7 pixels across, 3.2 km: a dozen cells each, no more.
    const wet = cells.filter((cell) => cell > 0).length;

    expect(wet).toBeGreaterThan(12);
    expect(wet).toBeLessThan(40);
  });

  it("leaves out echoes too faint to be rain", async () => {
    rainviewer(
      [1795157400],
      picture(() => HAZE)
    );

    expect(
      cellsOf((await fetchRadar())!.cells).every((cell) => cell === 0)
    ).toBe(true);
  });

  it("reads a picture RainViewer served, every colour of it", async () => {
    // Rain over the English Channel, asked for as this asks for Wellington
    // (it was dry there that day): what each cell should hold was worked
    // out apart, in Python, from the picture and RainViewer's colour table.
    rainviewer([1795157400], captured("channel-512-z7.png"));

    const cells = cellsOf((await fetchRadar())!.cells);
    const wet = cells.filter((cell) => cell > 0).length;
    const sum = cells.reduce((total, cell) => total + cell, 0);

    expect(Math.abs(wet - 12626)).toBeLessThan(126);
    expect(Math.abs(sum - 583011)).toBeLessThan(5830);
    expect(Math.max(...cells)).toBe(255);
    expect(cells[64 * RADAR_SIZE + 64]).toBe(0);
    expect(cells[100 * RADAR_SIZE + 20]).toBe(48);
    expect(cells[127 * RADAR_SIZE + 127]).toBe(65);
  });

  it("reads a dry evening over Wellington as dry", async () => {
    rainviewer([1795157400], captured("wellington-512-z7.png"));

    expect(
      cellsOf((await fetchRadar())!.cells).every((cell) => cell === 0)
    ).toBe(true);
  });

  it("is null, no picture fetched, when the newest frame's no newer", async () => {
    rainviewer(
      [1795156800, 1795157400],
      picture(() => BLUE)
    );

    expect(await fetchRadar(1795157400_000)).toBeNull();
    expect(asked).toEqual([]);
  });

  it("throws at a picture that isn't in its colours", async () => {
    // Its "Zoom Level Not Supported" notice is greys.
    rainviewer(
      [1795157400],
      picture((x) => (x % 2 ? [115, 115, 115, 255] : CLEAR))
    );

    await expect(fetchRadar()).rejects.toThrow(
      "rainviewer: a picture in colours that aren't its scheme's"
    );
  });

  it("throws at a picture of another size", async () => {
    rainviewer(
      [1795157400],
      encodePng(256, 256, new Uint8Array(256 * 256 * 4), { type: 6 })
    );

    await expect(fetchRadar()).rejects.toThrow(
      "rainviewer: a picture 256 by 256, not 512"
    );
  });

  it("only asks RainViewer's own hosts for pictures", async () => {
    rainviewer(
      [1795157400],
      picture(() => CLEAR),
      "https://tiles.example.com"
    );

    await expect(fetchRadar()).rejects.toThrow(
      "rainviewer: unexpected host or path"
    );

    expect(asked).toEqual([]);
  });

  it("throws when there are no frames, or it's down", async () => {
    rainviewer(
      [],
      picture(() => CLEAR)
    );

    await expect(fetchRadar()).rejects.toThrow("rainviewer: no frames");

    server.use(http.get(FRAMES, () => new HttpResponse(null, { status: 503 })));

    await expect(fetchRadar()).rejects.toThrow("rainviewer: HTTP 503");
  });
});

describe("the scans served", () => {
  const NOW = 1795158000_000;
  const MINUTE = 60_000;

  const scan = (minutes: number) => ({
    time: NOW - minutes * MINUTE,
    cells: `${minutes}`,
  });

  it("are the last half hour's, each once, oldest first", () => {
    expect(
      toRadar([scan(8), scan(48), scan(28), scan(18), scan(8), scan(38)], NOW)
    ).toEqual({ scans: [scan(38), scan(28), scan(18), scan(8)] });
  });

  it("are none when the radar's not been read lately", () => {
    expect(toRadar([scan(90), scan(80)], NOW)).toEqual({ scans: [] });
    expect(toRadar([], NOW)).toEqual({ scans: [] });
  });

  it("leave out those from after the moment asked for", () => {
    expect(toRadar([scan(8), scan(-2)], NOW)).toEqual({ scans: [scan(8)] });
  });
});
