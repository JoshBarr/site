import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fetchCloudMap,
  himawariPixel,
  MAP_SIZE,
  productAt,
} from "../../src/lib/cloudMap";
import { decodePng } from "../../src/lib/png";
import { freezeTime } from "../clock";
import { server } from "../msw";
import { encodePng } from "../fixtures/png";

// Where Himawari saw cloud over the map, from CIRA's SLIDER tiles: the
// visible band by day, the CLAVR-x cloud mask with the sun low, each read
// onto a 64² grid over the terrain's root, a kilometre a cell.

const SLIDER = "https://slider.cira.colostate.edu/data";

/** 1 pm NZDT: the sun's high. */
const MIDDAY = Date.parse("2026-11-02T00:00:00Z");

/** 9 pm NZDT: it's set. */
const NIGHT = Date.parse("2026-11-02T08:00:00Z");

const TILE = 688;

/** Where the map's centre (Wellington) is, cloud 1.5 km up, at zoom 5. */
const CENTRE = himawariPixel(-41.2865, 174.7762, 1500);

describe("Himawari's pixels", () => {
  it("puts Wellington where it is on the half-kilometre disk", () => {
    // Fitted to the coast on clear days.
    const { column, line } = himawariPixel(-41.29, 174.78);

    expect(column).toBeCloseTo(16032.4 + 5.5, 0);
    expect(line).toBeCloseTo(18796.6 + 8, 0);
  });

  it("sees cloud up high further from the satellite than the ground under it", () => {
    const ground = himawariPixel(-41.29, 174.78);
    const up = himawariPixel(-41.29, 174.78, 1500);

    // South and east, away from 140.7° E over the equator.
    expect(up.column).toBeGreaterThan(ground.column);
    expect(up.line).toBeGreaterThan(ground.line);
  });

  it("are the visible band's by day, the mask's with the sun down", () => {
    expect(productAt(MIDDAY)).toBe("visible");
    expect(productAt(NIGHT)).toBe("mask");
  });
});

describe("a PNG", () => {
  it("reads palette colours with their transparency, through every filter", () => {
    const palette = Uint8Array.from([0, 0, 0, 55, 55, 55, 165, 165, 165]);
    const pixels = Uint8Array.from({ length: 7 * 6 }, (_, i) => i % 3);

    const { width, height, rgba } = decodePng(
      encodePng(7, 6, pixels, {
        type: 3,
        palette,
        alpha: Uint8Array.from([0]),
      })
    );

    expect([width, height]).toEqual([7, 6]);

    for (let i = 0; i < pixels.length; i++) {
      const grey = [0, 55, 165][pixels[i]];

      expect([...rgba.subarray(i * 4, i * 4 + 4)]).toEqual([
        grey,
        grey,
        grey,
        pixels[i] === 0 ? 0 : 255,
      ]);
    }
  });

  it("reads grey and RGBA, through every filter", () => {
    const grey = Uint8Array.from({ length: 9 * 5 }, (_, i) => (i * 37) % 256);
    const read = decodePng(encodePng(9, 5, grey, { type: 0 }));

    expect([...read.rgba].filter((_, i) => i % 4 === 0)).toEqual([...grey]);

    const rgba = Uint8Array.from(
      { length: 4 * 5 * 4 },
      (_, i) => (i * 53) % 256
    );

    expect([...decodePng(encodePng(4, 5, rgba, { type: 6 })).rgba]).toEqual([
      ...rgba,
    ]);
  });

  it("throws on what isn't a PNG", () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(
      "png: not a PNG"
    );
  });
});

describe("the cloud map", () => {
  let tiles: string[];

  /**
   * SLIDER with scans at `times` of `product`, its tiles cloudy west of the
   * map's centre and clear east of it, as `paint` draws them.
   */
  function slider(
    product: string,
    times: number[],
    zoom: number,
    paint: (cloudy: boolean) => number[]
  ) {
    tiles = [];
    const scale = (TILE * 2 ** zoom) / 22016;

    server.use(
      http.get(
        `${SLIDER}/json/himawari/full_disk/${product}/latest_times.json`,
        () => HttpResponse.json({ timestamps_int: times })
      ),
      http.get(
        `${SLIDER}/imagery/:y/:m/:d/himawari---full_disk/${product}/:stamp/:zoom/:tile`,
        ({ params }) => {
          tiles.push(`${params.stamp}/${params.zoom}/${params.tile}`);
          const [, column] = String(params.tile).split(/[_.]/).map(Number);
          const pixels: number[] = [];

          for (let y = 0; y < TILE; y++) {
            for (let x = 0; x < TILE; x++) {
              pixels.push(
                ...paint(column * TILE + x + 0.5 < CENTRE.column * scale)
              );
            }
          }

          const type = paint(true).length === 4 ? 6 : 0;

          return new HttpResponse(
            encodePng(TILE, TILE, Uint8Array.from(pixels), { type }),
            { headers: { "Content-Type": "image/png" } }
          );
        }
      )
    );
  }

  const cellsOf = (cells: string) => Buffer.from(cells, "base64");

  /** The middle row's cells, west to east. */
  const middleRow = (cells: string) =>
    [...cellsOf(cells)].slice(
      (MAP_SIZE / 2) * MAP_SIZE,
      (MAP_SIZE / 2 + 1) * MAP_SIZE
    );

  beforeEach(() => freezeTime(MIDDAY));

  it("is cloudy where the visible band's bright, by day", async () => {
    // Cloud's 200, the sea's 20.
    slider("band_03", [20261101234000, 20261101235000], 5, (cloudy) => [
      cloudy ? 200 : 20,
    ]);

    const map = await fetchCloudMap();

    expect(map).toMatchObject({
      time: Date.parse("2026-11-01T23:50:00Z"),
      product: "visible",
    });

    expect(cellsOf(map!.cells)).toHaveLength(MAP_SIZE * MAP_SIZE);

    const row = middleRow(map!.cells);

    expect(row.slice(0, 28)).toEqual(Array(28).fill(255));
    expect(row.slice(36)).toEqual(Array(MAP_SIZE - 36).fill(0));

    // The map's all on one tile.
    expect(tiles).toEqual(["20261101235000/05/027_023.png"]);
  });

  it("is the mask's, with the sun down", async () => {
    freezeTime(NIGHT);

    // Clear's transparent; cloudy's grey 165.
    slider("cloud_mask_cira_clavr-x", [20261102071000], 3, (cloudy) =>
      cloudy ? [0, 0, 0, 0] : [165, 165, 165, 255]
    );

    const map = await fetchCloudMap();

    expect(map?.product).toBe("mask");

    const row = middleRow(map!.cells);

    // At 2 km a pixel the edge is blurred over a few cells.
    expect(row.slice(0, 26)).toEqual(Array(26).fill(0));
    expect(row.slice(38)).toEqual(Array(MAP_SIZE - 38).fill(255));
    expect(tiles).toEqual(["20261102071000/03/006_005.png"]);
  });

  it("is null, nothing fetched, when the newest scan's no newer", async () => {
    slider("band_03", [20261101235000], 5, () => [0]);

    expect(
      await fetchCloudMap(MIDDAY, Date.parse("2026-11-01T23:50:00Z"))
    ).toBeNull();

    expect(tiles).toEqual([]);
  });

  it("throws when a tile can't be fetched", async () => {
    server.use(
      http.get(
        `${SLIDER}/json/himawari/full_disk/band_03/latest_times.json`,
        () => HttpResponse.json({ timestamps_int: [20261101235000] })
      ),
      http.get(
        `${SLIDER}/imagery/*`,
        () => new HttpResponse(null, { status: 404 })
      )
    );

    await expect(fetchCloudMap()).rejects.toThrow("slider: HTTP 404");
  });
});
