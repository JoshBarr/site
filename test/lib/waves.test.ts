import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { fetchWaves } from "../../src/lib/waves";
import { ago, NOW } from "../clock";
import {
  buoy,
  DIRECTION,
  HEIGHT,
  NORTH,
  PERIOD,
  series,
  SOUTH,
  tideLevels,
} from "../fixtures/waveBuoy";
import { server } from "../msw";

// GWRC's wave buoy off Baring Head through Hilltop: the half hours it's
// sent lately, read into the sea over the last hour.

/** `minutes` before NOW. */
const minutesAgo = (minutes: number) => ago(minutes * 60);

describe("the wave buoy", () => {
  it("is asked for along with the tide gauges, three hours back", async () => {
    const asked = tideLevels(() => [
      buoy(SOUTH, [[minutesAgo(20), 1.4, 11, 185]]),
    ]);

    await fetchWaves(NOW);

    expect(asked).toEqual([
      "?Service=Hilltop&Request=GetData&Collection=Tide%20Levels&TimeInterval=PT185M%2Fnow",
    ]);
  });

  it("gives the sea over the hour to its newest reading", async () => {
    tideLevels(() => [
      buoy(SOUTH, [
        // Too long before the newest to count.
        [minutesAgo(110), 4, 6, 90],
        [minutesAgo(80), 1, 10, 170],
        [minutesAgo(50), 1, 10.4, 180],
        [minutesAgo(20), 2, 11.1, 190],
      ]),
    ]);

    expect(await fetchWaves(NOW)).toEqual({
      time: minutesAgo(20),
      // The root of the heights' mean square: √((1 + 1 + 4) / 3).
      height: 1.41,
      period: 10.5,
      direction: 180,
    });
  });

  it("averages directions either side of north as north", async () => {
    tideLevels(() => [
      buoy(SOUTH, [
        [minutesAgo(50), 0.5, 4, 350],
        [minutesAgo(20), 0.5, 4, 20],
      ]),
    ]);

    expect((await fetchWaves(NOW))?.direction).toBe(5);
  });

  it("is whichever of the two buoys reported last", async () => {
    tideLevels(() => [
      buoy(NORTH, [[minutesAgo(15), 2.5, 9, 200]]),
      buoy(SOUTH, [[minutesAgo(45), 1.2, 11, 180]]),
    ]);

    expect(await fetchWaves(NOW)).toEqual({
      time: minutesAgo(15),
      height: 2.5,
      period: 9,
      direction: 200,
    });
  });

  it("isn't a tide gauge, a retired buoy or one's offline twin", async () => {
    tideLevels(() => [
      series("Wellington Harbour at Queens Wharf", "Water Level", [
        [minutesAgo(1), 805],
      ]),
      buoy("Wellington Harbour at Baring Head Wave Buoy 2", [
        [minutesAgo(5), 9, 9, 9],
      ]),
      buoy(`${SOUTH}-Offline`, [[minutesAgo(5), 8, 8, 8]]),
      buoy("Taputeranga Marine Reserve Wave Buoy", [[minutesAgo(5), 7, 7, 7]]),
      series(SOUTH, "Maximum Wave Height (Hmax)", [[minutesAgo(20), 3.1]]),
      buoy(SOUTH, [[minutesAgo(20), 1.38, 11, 202.1]]),
    ]);

    expect(await fetchWaves(NOW)).toEqual({
      time: minutesAgo(20),
      height: 1.38,
      period: 11,
      direction: 202,
    });
  });

  it("leaves out a half hour that's missing a measurement, or isn't waves", async () => {
    tideLevels(() => [
      series(SOUTH, HEIGHT, [
        [minutesAgo(80), 1.1],
        [minutesAgo(50), 0],
        [minutesAgo(20), 3],
      ]),
      series(SOUTH, PERIOD, [
        [minutesAgo(80), 8],
        [minutesAgo(50), 0],
        [minutesAgo(20), 9],
      ]),
      series(SOUTH, DIRECTION, [
        [minutesAgo(80), 175],
        [minutesAgo(50), 0],
      ]),
    ]);

    expect(await fetchWaves(NOW)).toEqual({
      time: minutesAgo(80),
      height: 1.1,
      period: 8,
      direction: 175,
    });
  });

  it("has nothing to say when it's not been heard from for two hours", async () => {
    tideLevels(() => [buoy(SOUTH, [[minutesAgo(121), 1.4, 11, 185]])]);

    expect(await fetchWaves(NOW)).toBeNull();
  });

  it("has nothing to say when neither buoy's there", async () => {
    tideLevels(() => [
      series("Wellington Harbour at Queens Wharf", "Water Level", [
        [minutesAgo(1), 805],
      ]),
    ]);

    expect(await fetchWaves(NOW)).toBeNull();
  });

  it("fails when Hilltop says why", async () => {
    server.use(
      http.get(
        "https://hilltop.gw.govt.nz/data.hts",
        () => new HttpResponse("<Hilltop><Error>No data</Error></Hilltop>")
      )
    );

    await expect(fetchWaves(NOW)).rejects.toThrow("hilltop: No data");
  });
});
