import { beforeEach, describe, expect, it } from "vitest";
import { foldBuses } from "../../src/lib/busStore";
import type { Fix, RouteEnd } from "../../src/lib/flights";
import { foldFlights, pickLeg } from "../../src/lib/flightStore";
import { foldTrains } from "../../src/lib/trainStore";
import { foldVessels } from "../../src/lib/vesselStore";
import { ago, freezeTime, NOW } from "../clock";

// Folding the poller's logs (see plans/dynamo.md) into what the scene draws.

type Point = [number, number];

const STATION: Point = [1748900, 5428300];
const PETONE: Point = [1757500, 5436900];

const train = (position: Point, seconds: number, direction = 0) => ({
  id: "FP4123",
  line: "HVL" as const,
  direction,
  position,
  bearing: 200,
  time: ago(seconds),
});

const bus = (position: Point, seconds: number, route = "40") => ({
  id: "2158",
  route,
  direction: 1,
  position,
  bearing: 270,
  time: ago(seconds),
});

describe("folding the logs", () => {
  beforeEach(() => freezeTime());

  describe("trains", () => {
    it("joins each train's fixes across polls into its trail", () => {
      const folded = foldTrains([
        { sk: ago(40), data: { trains: [train(PETONE, 45)] } },
        // The same fix again.
        { sk: ago(30), data: { trains: [train(PETONE, 45)] } },
        // Turned around, on its way back in.
        { sk: ago(5), data: { trains: [train(STATION, 10, 1)] } },
      ]);

      expect(folded).toEqual([
        {
          ...train(STATION, 10, 1),
          trail: [
            [...PETONE, ago(45)],
            [...STATION, ago(10)],
          ],
        },
      ]);
    });

    it("draws only those in the newest poll, and not those gone quiet", () => {
      const folded = foldTrains([
        { sk: ago(60), data: { trains: [{ ...train(PETONE, 60), id: "A" }] } },
        { sk: ago(5), data: { trains: [train(STATION, 6 * 60)] } },
      ]);

      expect(folded).toEqual([]);
    });

    it("trails back three minutes", () => {
      const [folded] = foldTrains([
        { sk: ago(200), data: { trains: [train(PETONE, 200)] } },
        { sk: ago(5), data: { trains: [train(STATION, 10)] } },
      ]);

      expect(folded.trail).toEqual([[...STATION, ago(10)]]);
    });

    it("folds nothing to nothing", () => {
      expect(foldTrains([])).toEqual([]);
    });
  });

  it("leaves a bus's last trip's trail behind when it starts another", () => {
    const [folded] = foldBuses([
      { sk: ago(60), data: { buses: [bus(PETONE, 60, "83")] } },
      { sk: ago(40), data: { buses: [bus(PETONE, 45)] } },
      { sk: ago(5), data: { buses: [bus(STATION, 10)] } },
    ]);

    expect(folded.trail).toEqual([
      [...PETONE, ago(45)],
      [...STATION, ago(10)],
    ]);
  });

  it("keeps a quiet bus's own fix as its trail, though it's older than the trail", () => {
    // Heard from four minutes ago: past the 3 min trail, short of stale.
    const [folded] = foldBuses([
      { sk: ago(5), data: { buses: [bus(STATION, 240)] } },
    ]);

    expect(folded.trail).toEqual([[...STATION, ago(240)]]);
  });

  describe("vessels", () => {
    const ferry = (
      trail: [number, number, number][],
      seconds = 20,
      speed = 8.6
    ) => ({
      mmsi: 512003410,
      name: "COBAR CAT",
      type: 60,
      position: STATION,
      speed,
      course: 253.6,
      heading: null,
      dimension: null,
      time: ago(seconds),
      trail,
    });

    it("joins each poll's tracks into a ship's trail, back 15 minutes", () => {
      const [folded] = foldVessels([
        {
          sk: ago(16 * 60),
          data: { vessels: [ferry([[1, 1, ago(16 * 60)]])] },
        },
        {
          sk: ago(120),
          data: {
            vessels: [
              ferry([
                [1, 2, ago(140)],
                [1, 3, ago(130)],
              ]),
            ],
          },
        },
        // Fetched again, overlapping.
        {
          sk: ago(60),
          data: {
            vessels: [
              ferry([
                [1, 3, ago(130)],
                [1, 4, ago(70)],
              ]),
            ],
          },
        },
      ]);

      expect(folded.trail).toEqual([
        [1, 2, ago(140)],
        [1, 3, ago(130)],
        [1, 4, ago(70)],
      ]);
    });

    it("draws moored ships from a poll hours old", () => {
      const moored = ferry([], 3 * 3600, 0);

      expect(
        foldVessels([{ sk: ago(3 * 3600), data: { vessels: [moored] } }])
      ).toEqual([moored]);
    });

    it("leaves out ships under way gone quiet", () => {
      expect(
        foldVessels([{ sk: ago(60), data: { vessels: [ferry([], 11 * 60)] } }])
      ).toEqual([]);
    });
  });

  describe("flights", () => {
    const WLG: RouteEnd = {
      code: "WLG",
      at: [1749000, 5427000],
      elevation: 12.5,
    };

    const NSN: RouteEnd = {
      code: "NSN",
      at: [1620000, 5432000],
      elevation: 10.36,
    };

    const AKL: RouteEnd = {
      code: "AKL",
      at: [1757000, 5720000],
      elevation: null,
    };

    const details = {
      hex: "c81e2c",
      callsign: "ANZ441",
      registration: "ZK-NHA",
      type: "A21N",
      category: "A3",
    };

    const fix = (
      [e, n]: Point,
      seconds: number,
      track: number | null = 0
    ): Fix => [e, n, 1000, ago(seconds), 100, track, 0];

    it("gathers each aircraft's fixes, in order, each once", () => {
      const [folded] = foldFlights(
        [
          {
            sk: ago(20),
            data: { sightings: [{ aircraft: details, fix: fix([1, 1], 20) }] },
          },
          {
            sk: ago(10),
            data: {
              sightings: [
                { aircraft: details, fix: fix([1, 1], 20) },
                { aircraft: details, fix: fix([1, 2], 10) },
              ],
            },
          },
        ],
        new Map()
      );

      expect(folded).toEqual({
        ...details,
        fixes: [fix([1, 1], 20), fix([1, 2], 10)],
      });
    });

    it("goes back only so far", () => {
      const folded = foldFlights(
        [
          {
            sk: ago(8 * 60),
            data: {
              sightings: [{ aircraft: details, fix: fix([1, 1], 8 * 60) }],
            },
          },
        ],
        new Map()
      );

      expect(folded).toEqual([]);
    });

    it("says a route isn't known, or leaves it out if it wasn't looked up", () => {
      const sighting = (callsign: string | null) => ({
        aircraft: { ...details, hex: callsign ?? "none", callsign },
        fix: fix([1, 1], 10),
      });

      const folded = foldFlights(
        [
          {
            sk: NOW,
            data: {
              sightings: [
                sighting("QFA163"),
                sighting("JST221"),
                sighting(null),
              ],
            },
          },
        ],
        new Map([["QFA163", null]])
      );

      expect(folded.map(({ route }) => route)).toEqual([null, undefined, null]);

      expect(folded[1]).not.toHaveProperty("route");
    });

    describe("picking the leg being flown", () => {
      const route = [NSN, WLG, AKL];

      it("is the leg in, for one arriving", () => {
        // East over the Strait, towards Wellington.
        const fixes = [fix([1725000, 5428500], 60), fix([1735000, 5428000], 1)];

        expect(pickLeg(route, fixes)).toEqual({ from: NSN, to: WLG });
      });

      it("is the leg out, for one leaving", () => {
        // North, away from Wellington.
        const fixes = [fix([1751000, 5440000], 60), fix([1752000, 5450000], 1)];

        expect(pickLeg(route, fixes)).toEqual({ from: WLG, to: AKL });
      });

      it("goes by its track if it's barely moved", () => {
        const at: Point = [1749500, 5428000];

        expect(pickLeg(route, [fix(at, 1, 10)])).toEqual({
          from: WLG,
          to: AKL,
        });

        // East-south-east: back the way it'd go to Auckland.
        expect(pickLeg(route, [fix(at, 1, 100)])).toEqual({
          from: NSN,
          to: WLG,
        });
      });

      it("is joined to the aircraft flying it", () => {
        const [folded] = foldFlights(
          [
            {
              sk: NOW,
              data: {
                sightings: [
                  { aircraft: details, fix: fix([1751000, 5440000], 60) },
                  { aircraft: details, fix: fix([1752000, 5450000], 1) },
                ],
              },
            },
          ],
          new Map([["ANZ441", route]])
        );

        expect(folded.route).toEqual({ from: WLG, to: AKL });
      });
    });
  });
});
