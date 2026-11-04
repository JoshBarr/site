import { HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchAirspace, lookupRoutes } from "../../src/lib/flightStore";
import { toNztm } from "../../src/lib/nztm";
import { freezeTime } from "../clock";
import { adsb, airspace, ANZ441, QFA163, routeReply } from "../fixtures/adsb";

// adsb.lol's aircraft around Wellington, and adsb.im's routes for them, as
// the poller reads them. The everyday cases are in the poller's tests
// (infra/test/poller.test.ts); these are the edges.

const FEET = 0.3048;

/** Wellington Airport, NZTM. */
const [WLG_E, WLG_N] = toNztm(-41.327, 174.805);

describe("adsb.lol's airspace", () => {
  beforeEach(() => freezeTime());

  it("asks as the scene", async () => {
    const { airspace: requests } = adsb(() => HttpResponse.json(airspace([])));

    await fetchAirspace();

    expect(requests[0].headers.get("user-agent")).toBe("joshbarr.com scene");
  });

  it("is empty when nothing's about", async () => {
    adsb(() => HttpResponse.json({ now: Date.now(), msg: "No error" }));

    expect(await fetchAirspace()).toEqual([]);
  });

  it("goes by pressure altitude as it is with no GNSS altitude to correct it by", async () => {
    adsb(() => HttpResponse.json(airspace([QFA163])));

    const [{ fix }] = await fetchAirspace();

    expect(fix[2]).toBe(Math.round(10000 * FEET));
  });

  it("corrects pressure altitudes by the middle of the others' errors", async () => {
    adsb(() =>
      HttpResponse.json(
        airspace([
          { ...ANZ441, hex: "a", alt_baro: 3000, alt_geom: 3100 },
          { ...ANZ441, hex: "b", alt_baro: 5000, alt_geom: 5150 },
          // A bad GNSS fix: it doesn't drag the correction with it.
          { ...ANZ441, hex: "c", alt_baro: 7000, alt_geom: 9000 },
          QFA163,
        ])
      )
    );

    const fixes = await fetchAirspace();

    expect(fixes.at(-1)?.fix[2]).toBe(Math.round(10150 * FEET));
  });

  it("goes by heading without a track, and pressure's rate without GNSS's", async () => {
    adsb(() =>
      HttpResponse.json(
        airspace([
          {
            hex: "d",
            lat: -41.3,
            lon: 174.8,
            alt_baro: 2000,
            true_heading: 123,
            baro_rate: 600,
          },
        ])
      )
    );

    const [{ aircraft, fix }] = await fetchAirspace();

    expect(aircraft).toEqual({
      hex: "d",
      callsign: null,
      registration: null,
      type: null,
      category: null,
    });

    expect(fix.slice(4)).toEqual([0, 123, (600 * FEET) / 60]);
  });

  it("fails when adsb.lol turns it away", async () => {
    adsb(() => new HttpResponse(null, { status: 429 }));

    await expect(fetchAirspace()).rejects.toThrow("adsb.lol: HTTP 429");
  });
});

describe("adsb.im's routes", () => {
  const asking = new Map<string, [number, number]>([
    ["ANZ441", [ANZ441.lat, ANZ441.lon]],
    ["QFA163", [QFA163.lat, QFA163.lon]],
  ]);

  it("are every airport stopped at, those far off pulled in to 300 km", async () => {
    adsb(
      () => HttpResponse.json(airspace([])),
      () => HttpResponse.json([routeReply("QFA163", ["SYD", "WLG"])])
    );

    const route = (await lookupRoutes(asking)).get("QFA163");

    expect(route?.map(({ code, elevation }) => [code, elevation])).toEqual([
      ["SYD", null],
      ["WLG", 12.5],
    ]);

    const [easting, northing] = route?.[0].at ?? [0, 0];

    expect(Math.hypot(easting - WLG_E, northing - WLG_N) / 1000).toBeCloseTo(
      300,
      -1
    );

    // Towards Sydney: west, and a little north.
    expect(easting).toBeLessThan(WLG_E - 250_000);
    expect(northing).toBeGreaterThan(WLG_N);
  });

  it("aren't known when adsb.im doesn't think them plausible, or has one airport", async () => {
    adsb(
      () => HttpResponse.json(airspace([])),
      () =>
        HttpResponse.json([
          { ...routeReply("ANZ441", ["AKL", "WLG"]), plausible: 0 },
          routeReply("QFA163", ["SYD"]),
        ])
    );

    expect(await lookupRoutes(asking)).toEqual(
      new Map([
        ["ANZ441", null],
        ["QFA163", null],
      ])
    );
  });

  it("leave out callsigns that weren't asked about", async () => {
    adsb(
      () => HttpResponse.json(airspace([])),
      () =>
        HttpResponse.json([
          routeReply("ANZ441", ["AKL", "WLG"]),
          routeReply("JST221", ["AKL", "WLG"]),
        ])
    );

    expect([...(await lookupRoutes(asking)).keys()]).toEqual(["ANZ441"]);
  });

  it("fail when adsb.im does", async () => {
    adsb(
      () => HttpResponse.json(airspace([])),
      () => new HttpResponse(null, { status: 500 })
    );

    await expect(lookupRoutes(asking)).rejects.toThrow("adsb.im: HTTP 500");
  });

  it("fail when it answers with something else", async () => {
    adsb(
      () => HttpResponse.json(airspace([])),
      () => HttpResponse.json({ error: "busy" })
    );

    await expect(lookupRoutes(asking)).rejects.toThrow(
      "adsb.im: unexpected response"
    );
  });
});
