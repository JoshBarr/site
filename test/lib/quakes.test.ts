import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { toNztm } from "../../src/lib/nztm";
import { fetchQuakes, intensity } from "../../src/lib/quakes";
import { ago } from "../clock";
import { server } from "../msw";

// GeoNet's newest quakes, read into those the scene ripples.

const GEONET = "https://api.geonet.org.nz/quake";

/** A GeoNet quake at longitude, latitude, `seconds` ago. */
const reported = (
  id: string,
  [lon, lat]: [number, number],
  magnitude: number,
  seconds: number,
  { depth = 12.345, quality = "best" } = {}
) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: {
    publicID: id,
    time: new Date(ago(seconds)).toISOString(),
    depth,
    magnitude,
    mmi: 3,
    locality: `near ${id}`,
    quality,
  },
});

/** GeoNet answering with `features`. The requests made are returned. */
function geonet(features: unknown[]) {
  const requests: Request[] = [];

  server.use(
    http.get(GEONET, ({ request }) => {
      requests.push(request);

      return HttpResponse.json({ type: "FeatureCollection", features });
    })
  );

  return requests;
}

describe("GeoNet's quakes", () => {
  it("asks for every quake, in GeoJSON's second version", async () => {
    const requests = geonet([]);

    await fetchQuakes();

    expect(new URL(requests[0].url).searchParams.get("MMI")).toBe("-1");

    expect(requests[0].headers.get("accept")).toBe(
      "application/vnd.geo+json;version=2"
    );
  });

  it("places each in NZTM to the metre, its depth and magnitude rounded", async () => {
    geonet([
      reported("2026p1", [174.95, -40.9], 2.3456, 60, { depth: 20.1234 }),
    ]);

    const [easting, northing] = toNztm(-40.9, 174.95);

    expect(await fetchQuakes()).toEqual([
      {
        id: "2026p1",
        time: ago(60),
        position: [Math.round(easting), Math.round(northing)],
        depth: 20.1,
        magnitude: 2.35,
        locality: "near 2026p1",
        quality: "best",
      },
    ]);
  });

  it("lists them oldest first, as GeoNet lists them newest first", async () => {
    geonet([
      reported("newest", [174.8, -41.3], 2, 30),
      reported("middle", [174.8, -41.3], 2, 300),
      reported("oldest", [174.8, -41.3], 2, 3000),
    ]);

    expect((await fetchQuakes()).map(({ id }) => id)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
  });

  it("keeps a far quake only if it shook Wellington", async () => {
    geonet([
      // Hawke's Bay, 300 km off: a big one's felt, a small one isn't.
      reported("felt", [176.9, -39.5], 6.5, 60, { depth: 30 }),
      reported("unfelt", [176.9, -39.5], 3.5, 60, { depth: 30 }),
      // Under the harbour: on the map, however small.
      reported("tiny", [174.8, -41.3], 0.8, 60),
    ]);

    expect((await fetchQuakes()).map(({ id }) => id)).toEqual(["felt", "tiny"]);
  });

  it("leaves out those found not to be quakes", async () => {
    geonet([
      reported("real", [174.8, -41.3], 2, 60),
      reported("gone", [174.8, -41.3], 2, 60, { quality: "deleted" }),
    ]);

    expect((await fetchQuakes()).map(({ id }) => id)).toEqual(["real"]);
  });

  describe("fails", () => {
    it("when GeoNet does", async () => {
      server.use(
        http.get(GEONET, () => new HttpResponse(null, { status: 500 }))
      );

      await expect(fetchQuakes()).rejects.toThrow("geonet: HTTP 500");
    });

    it("when it answers with something else", async () => {
      geonet([{ geometry: { coordinates: [174.8] }, properties: {} }]);

      await expect(fetchQuakes()).rejects.toThrow(
        "geonet: unexpected response"
      );
    });
  });
});

describe("an earthquake's intensity, near its fault", () => {
  it("stops growing within a few km", () => {
    expect(intensity(5, 0)).toBe(intensity(5, 5));
    expect(intensity(5, 1)).toBe(intensity(5, 5));
    expect(intensity(5, 6)).toBeLessThan(intensity(5, 5));
  });
});
