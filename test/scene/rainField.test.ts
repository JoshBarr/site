import { afterEach, describe, expect, it } from "vitest";
import {
  radarMotion,
  rainAt,
  rainField,
  setRainField,
  stepRainField,
} from "../../src/components/scene/clouds/rainField";
import { RADAR_SIZE, RADAR_SPAN } from "../../src/lib/radarGrid";

// The gauges' rates spread across the map: the share of the hardest rain
// falling at each place, and where the cloud closes over it.

const shareAt = (x: number, z: number) => rainAt(x, z).share;

describe("the rain field", () => {
  afterEach(() => {
    rainField.deck.value = 0;
  });

  it("rains the forecast everywhere without gauges", () => {
    expect(setRainField(null)).toBeNull();
    expect(setRainField([])).toBeNull();
    expect(shareAt(0, 0)).toBe(1);
    expect(shareAt(-20_000, 15_000)).toBe(1);
  });

  it("rains as hard as the wettest gauge by it, and not by a dry one", () => {
    expect(
      setRainField([
        { x: 10_000, z: 0, rate: 6 },
        { x: -10_000, z: 0, rate: 0 },
      ])
    ).toBeCloseTo(6, 1);

    expect(shareAt(10_000, 0)).toBeGreaterThan(0.99);
    expect(shareAt(-10_000, 0)).toBeLessThan(0.01);

    // Halfway between, half the rate.
    expect(shareAt(0, 0)).toBeCloseTo(0.5 ** 0.63, 1);
  });

  it("goes by the nearest gauge far from them all", () => {
    setRainField([
      { x: 10_000, z: 0, rate: 6 },
      { x: -10_000, z: 0, rate: 0 },
    ]);

    expect(shareAt(30_000, 30_000)).toBeGreaterThan(0.99);
    expect(shareAt(-30_000, -30_000)).toBeLessThan(0.01);
  });

  it("closes the cloud over the rain, and not over a dry gauge near it", () => {
    setRainField([
      { x: 0, z: 0, rate: 4 },
      { x: 5_000, z: 0, rate: 0 },
    ]);

    rainField.deck.value = 1;

    expect(rainAt(0, 0).deck).toBeCloseTo(1, 2);
    expect(rainAt(5_000, 0).deck).toBe(0);
    expect(shareAt(5_000, 0)).toBeLessThan(0.3);
  });

  it("is dry when the gauges only caught a trace", () => {
    expect(
      setRainField([
        { x: 0, z: 0, rate: 0.2 },
        { x: 5_000, z: 0, rate: 0 },
      ])
    ).toBe(0);
  });
});

// The radar's scans over the gauges: where the rain is and how it moves is
// the radar's, how hard it is where there are gauges is theirs.

const MINUTE = 60_000;

/** When the newest scan was. */
const SCANNED = Date.parse("2026-11-02T06:50:00Z");

/** A scan at `time` of what `paint` gives each cell's centre, mm/h. */
const scan = (time: number, paint: (x: number, z: number) => number) => ({
  time,
  rates: Float32Array.from({ length: RADAR_SIZE * RADAR_SIZE }, (_, k) => {
    const cell = RADAR_SPAN / RADAR_SIZE;

    return paint(
      -RADAR_SPAN / 2 + ((k % RADAR_SIZE) + 0.5) * cell,
      -RADAR_SPAN / 2 + (Math.floor(k / RADAR_SIZE) + 0.5) * cell
    );
  }),
});

/** A shower `rate` mm/h hard, `radius` m across its middle, at x, z. */
const shower =
  (x: number, z: number, rate = 6, radius = 4000) =>
  (px: number, pz: number) =>
    Math.hypot(px - x, pz - z) < radius ? rate : 0;

const dry = () => 0;

/** The rate at x, z, mm/h. */
const rateAt = (x: number, z: number) =>
  rainAt(x, z).share ** (1 / 0.63) * rainField.hardest.value;

describe("the rain field, with the radar", () => {
  afterEach(() => {
    rainField.deck.value = 0;
    setRainField(null);
  });

  it("rains where the radar sees rain, with no gauges at all", () => {
    expect(
      setRainField(null, {
        scans: [scan(SCANNED, shower(10_000, -5_000))],
        now: SCANNED,
      })
    ).toBeCloseTo(6, 1);

    expect(shareAt(10_000, -5_000)).toBeGreaterThan(0.99);
    expect(shareAt(10_000, 2_000)).toBe(0);
    expect(shareAt(-20_000, -5_000)).toBe(0);

    // And closes the cloud over it.
    rainField.deck.value = 1;
    expect(rainAt(10_000, -5_000).deck).toBeCloseTo(1, 2);
    expect(rainAt(-20_000, -5_000).deck).toBe(0);
  });

  it("is dry, whatever the forecast, when the radar and the gauges see none", () => {
    expect(
      setRainField([{ x: 0, z: 0, rate: 0 }], {
        scans: [scan(SCANNED, dry)],
        now: SCANNED,
      })
    ).toBe(0);

    expect(
      setRainField(null, { scans: [scan(SCANNED, dry)], now: SCANNED })
    ).toBe(0);
  });

  it("finds how far the rain moved between two scans", () => {
    const moved = radarMotion(
      scan(0, shower(-8_000, 4_000, 6, 7000)).rates,
      scan(0, shower(-2_000, 0, 6, 7000)).rates
    );

    expect(moved?.[0]).toBeCloseTo(6_000, -3);
    expect(moved?.[1]).toBeCloseTo(-4_000, -3);
  });

  it("can't say how it moved with next to no rain, or none alike", () => {
    const here = scan(0, shower(0, 0, 6, 1500)).rates;

    expect(radarMotion(here, here)).toBeNull();
    expect(
      radarMotion(scan(0, dry).rates, scan(0, shower(0, 0)).rates)
    ).toBeNull();

    // Rain at opposite corners of the grid: too far to be the same.
    expect(
      radarMotion(
        scan(0, shower(-50_000, -50_000, 6, 8000)).rates,
        scan(0, shower(50_000, 50_000, 6, 8000)).rates
      )
    ).toBeNull();
  });

  it("carries the newest scan's showers on by how they moved since the last", () => {
    // 6 km east in ten minutes, 10 m/s; seen eight minutes after the scan.
    const scans = [
      scan(SCANNED - 10 * MINUTE, shower(-12_000, 0)),
      scan(SCANNED, shower(-6_000, 0)),
    ];

    setRainField(null, { scans, now: SCANNED + 8 * MINUTE });

    // 4.8 km on.
    expect(shareAt(-1_200, 0)).toBeGreaterThan(0.95);
    expect(shareAt(-9_000, 0)).toBe(0);
    expect(shareAt(4_500, 0)).toBe(0);
  });

  it("carries them on as the scene's time passes, a step at a time", () => {
    const scans = [
      scan(SCANNED - 10 * MINUTE, shower(-12_000, 0)),
      scan(SCANNED, shower(-6_000, 0)),
    ];

    setRainField(null, { scans, now: SCANNED });
    expect(shareAt(-6_000, 0)).toBeGreaterThan(0.95);

    // A second on, they've not moved enough to draw again.
    stepRainField(SCANNED + 1000);
    expect(shareAt(-9_500, 0)).toBeGreaterThan(0.5);

    expect(stepRainField(SCANNED + 10 * MINUTE)).toBeCloseTo(6, 1);
    expect(shareAt(0, 0)).toBeGreaterThan(0.95);
    expect(shareAt(-6_000, 0)).toBe(0);

    // No further than 25 minutes' drift: by then it's a guess.
    stepRainField(SCANNED + 60 * MINUTE);
    expect(shareAt(9_000, 0)).toBeGreaterThan(0.95);
    expect(shareAt(20_000, 0)).toBe(0);
  });

  it("drifts a lone scan's showers on the wind it's given", () => {
    setRainField(null, {
      scans: [scan(SCANNED, shower(0, 0))],
      now: SCANNED + 10 * MINUTE,
      drift: [0, 10],
    });

    // 6 km south.
    expect(shareAt(0, 6_000)).toBeGreaterThan(0.95);
    expect(shareAt(0, 0)).toBeLessThan(0.05);
  });

  it("brings showers on to the map from beyond its edge", () => {
    // 40 km west of the centre: off the map, on the radar's grid.
    setRainField(null, {
      scans: [scan(SCANNED, shower(-40_000, 0))],
      now: SCANNED,
      drift: [12, 0],
    });

    expect(shareAt(-30_000, 0)).toBe(0);
    expect(stepRainField(SCANNED + 15 * MINUTE)).toBeCloseTo(6, 1);
    expect(shareAt(-29_200, 0)).toBeGreaterThan(0.95);
  });

  it("scales the radar's rates to what the gauges under it caught", () => {
    // The radar reads 2 mm/h across the map; three gauges caught 4.
    const scans = [scan(SCANNED, () => 2)];

    const gauges = [
      { x: -5_000, z: 0, rate: 4 },
      { x: 5_000, z: 0, rate: 4 },
      { x: 0, z: 8_000, rate: 4 },
    ];

    expect(setRainField(gauges, { scans, now: SCANNED })).toBeCloseTo(4, 1);

    // Far from any gauge too.
    expect(rateAt(-28_000, -28_000)).toBeCloseTo(4, 1);
  });

  it("scales it by no more than three times, and not by a gauge or two", () => {
    const scans = [scan(SCANNED, () => 1)];

    const gauges = [
      { x: -5_000, z: 0, rate: 9 },
      { x: 5_000, z: 0, rate: 9 },
      { x: 0, z: 8_000, rate: 9 },
    ];

    setRainField(gauges, { scans, now: SCANNED });
    expect(rateAt(-28_000, -28_000)).toBeCloseTo(3, 1);

    // By the gauges it's still what they caught.
    expect(rateAt(-5_000, 0)).toBeCloseTo(9, 0);

    setRainField(gauges.slice(0, 2), { scans, now: SCANNED });
    expect(rateAt(-28_000, -28_000)).toBeCloseTo(1, 1);
  });

  it("rains at a gauge catching rain the radar's beam passes over", () => {
    expect(
      setRainField(
        [
          { x: 0, z: 0, rate: 3 },
          { x: 12_000, z: 0, rate: 0 },
        ],
        { scans: [scan(SCANNED, dry)], now: SCANNED }
      )
    ).toBeCloseTo(3, 1);

    expect(shareAt(0, 0)).toBeGreaterThan(0.99);
    expect(shareAt(12_000, 0)).toBe(0);

    // Not, as the gauges alone would, all the way to the map's edge.
    expect(shareAt(-25_000, 0)).toBe(0);
  });

  it("doesn't rain on a dry gauge under an echo that's sat there", () => {
    // The same echo in every scan for half an hour, and the bucket's not
    // tipped: clutter, or rain that dries up on the way down.
    const echo = shower(0, 0, 5, 3000);

    const scans = [20, 10, 0].map((minutes) =>
      scan(SCANNED - minutes * MINUTE, (x, z) =>
        Math.max(echo(x, z), shower(-20_000, 15_000)(x, z))
      )
    );

    setRainField([{ x: 0, z: 0, rate: 0 }], { scans, now: SCANNED });

    expect(rateAt(0, 0)).toBeLessThan(0.3);

    // The shower out past the gauges is none of its business.
    expect(rateAt(-20_000, 15_000)).toBeCloseTo(6, 1);
  });

  it("lets a shower that's crossed a gauge move on from it", () => {
    // Over the gauge twenty minutes back, 12 km east of it now: the gauge
    // caught 2 mm/h of it over the half hour, as the radar saw there.
    const scans = [20, 10, 0].map((minutes) =>
      scan(SCANNED - minutes * MINUTE, shower(12_000 - minutes * 600, 0))
    );

    setRainField([{ x: 0, z: 0, rate: 2 }], { scans, now: SCANNED });

    expect(rateAt(0, 0)).toBeLessThan(0.3);
    expect(rateAt(12_000, 0)).toBeCloseTo(6, 0);
  });

  it("goes by the gauges alone once the newest scan's old", () => {
    const gauges = [
      { x: 10_000, z: 0, rate: 6 },
      { x: -10_000, z: 0, rate: 0 },
    ];

    expect(
      setRainField(gauges, {
        scans: [scan(SCANNED, shower(-20_000, 0, 9))],
        now: SCANNED + 41 * MINUTE,
      })
    ).toBeCloseTo(6, 1);

    expect(shareAt(-20_000, 0)).toBeLessThan(0.01);
    expect(shareAt(30_000, 30_000)).toBeGreaterThan(0.99);

    // Nothing to carry on.
    expect(stepRainField(SCANNED + 50 * MINUTE)).toBeCloseTo(6, 1);
  });

  it("fades from the last scan's guess to a newer scan", () => {
    const first = scan(SCANNED - 10 * MINUTE, shower(-10_000, 0));
    const next = scan(SCANNED, shower(10_000, 15_000));

    setRainField(null, { scans: [first], now: SCANNED - 2 * MINUTE }, 0);

    // The newer one shows the shower somewhere else altogether.
    setRainField(
      null,
      { scans: [first, next], now: SCANNED + 6 * MINUTE },
      5000
    );
    expect(rateAt(-10_000, 0)).toBeCloseTo(6, 1);
    expect(rateAt(10_000, 15_000)).toBeCloseTo(0, 1);

    stepRainField(SCANNED + 6 * MINUTE, 15_000);
    expect(rateAt(-10_000, 0)).toBeCloseTo(3, 0);
    expect(rateAt(10_000, 15_000)).toBeCloseTo(3, 0);

    expect(stepRainField(SCANNED + 6 * MINUTE, 26_000)).toBeCloseTo(6, 1);
    expect(rateAt(-10_000, 0)).toBe(0);
    expect(rateAt(10_000, 15_000)).toBeCloseTo(6, 1);
  });

  it("keeps the share right as the hardest shower leaves the map", () => {
    // A downpour about to leave east, drizzle that stays.
    setRainField(null, {
      scans: [
        scan(SCANNED, (x, z) =>
          Math.max(shower(28_000, 0, 20)(x, z), shower(-10_000, 0, 1)(x, z))
        ),
      ],
      now: SCANNED,
      drift: [15, 0],
    });

    expect(rateAt(-10_000, 0)).toBeCloseTo(1, 1);

    // 13.5 km on: the downpour's off the map.
    expect(stepRainField(SCANNED + 15 * MINUTE)).toBeCloseTo(1, 1);
    expect(rateAt(3_500, 0)).toBeCloseTo(1, 1);
    expect(shareAt(3_500, 0)).toBeGreaterThan(0.95);
  });
});
