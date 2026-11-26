import { describe, expect, it } from "vitest";
import {
  BUCKETS,
  CAGE_RADIUS,
  CAGE_TOP,
  FEEDS,
  HUB,
  OUTLETS,
  RAILS,
} from "../../src/components/scene/bucket/layout";
import {
  type Hang,
  place,
  shell,
} from "../../src/components/scene/bucket/shape";
import { POOL, toLocal, toWorld } from "../../src/components/scene/bucket/site";
import {
  createTipping,
  FULL_TIP,
} from "../../src/components/scene/bucket/tipping";

/** Points over a bucket's shell, in the fountain's frame, at a lean. */
function outline(bucket: Hang, tip: number) {
  const points: number[][] = [];

  for (const s of [0, 0.35, 0.7, 1]) {
    for (let k = 0; k < 12; k++) {
      points.push(place(bucket, shell(s, (k / 12) * 2 * Math.PI), tip));
    }
  }

  return points;
}

describe("the Bucket Fountain's site", () => {
  it("turns between the map and its own frame both ways", () => {
    const [x, z] = toLocal(3, -2);
    const [east, south] = toWorld(x, z);

    expect(east).toBeCloseTo(3, 9);
    expect(south).toBeCloseTo(2, 9);
  });

  it("has its pool laid down the mall: long in z, narrow in x", () => {
    const local = POOL.map(([e, n]) => toLocal(e, n));

    const span = (k: 0 | 1) =>
      Math.max(...local.map((p) => p[k])) - Math.min(...local.map((p) => p[k]));

    expect(span(1)).toBeGreaterThan(7);
    expect(span(0)).toBeLessThan(5.5);
  });
});

describe("the Bucket Fountain's cascades", () => {
  it("feeds every bucket, from the pipe or one above, and ends in the pool", () => {
    BUCKETS.forEach((_, i) => {
      const fed =
        FEEDS.some(({ into }) => into === i) ||
        BUCKETS.some(({ into }) => into === i);

      expect(fed, BUCKETS[i].name).toBe(true);

      // Down the cascade, never round in a loop.
      let at = i;
      let steps = 0;

      while (at >= 0 && steps++ < BUCKETS.length) at = BUCKETS[at].into;

      expect(at, BUCKETS[i].name).toBe(-1);
    });

    expect(OUTLETS.length).toBe(FEEDS.length);
  });

  it("hangs each bucket over the one it pours into", () => {
    for (const bucket of BUCKETS) {
      if (bucket.into < 0) continue;

      expect(bucket.pivot[1]).toBeGreaterThan(BUCKETS[bucket.into].pivot[1]);
    }
  });

  it("swings its buckets clear of the feed pipe, the rails and each other", () => {
    const tips = [0, 1, FULL_TIP];

    for (const [i, a] of BUCKETS.entries()) {
      for (const tip of tips) {
        for (const [x, y, z] of outline(a, tip)) {
          if (y > HUB && y < CAGE_TOP) {
            expect(Math.hypot(x, z), `${a.name} at ${tip}`).toBeGreaterThan(
              0.08
            );
          }

          if (y > HUB + 0.8) {
            for (const r of RAILS) {
              const rx = Math.sin(r) * CAGE_RADIUS;
              const rz = Math.cos(r) * CAGE_RADIUS;

              expect(Math.hypot(x - rx, z - rz)).toBeGreaterThan(0.07);
            }
          }
        }
      }

      // One swinging, the other at rest.
      for (const b of BUCKETS.slice(i + 1)) {
        for (const [one, two] of [
          [a, b],
          [b, a],
        ]) {
          const still = outline(two, 0);

          for (const tip of tips) {
            for (const p of outline(one, tip)) {
              const nearest = Math.min(
                ...still.map((q) =>
                  Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
                )
              );

              expect(nearest, `${one.name} by ${two.name}`).toBeGreaterThan(
                0.05
              );
            }
          }
        }
      }
    }
  });
});

describe("a bucket tipping", () => {
  const lone = {
    size: 0.5,
    trip: 0.6,
    into: -1,
    caught: 1,
    fall: 0.3,
  };

  it("fills, tips over, empties and swings back to its stop", () => {
    const tipping = createTipping([lone], [{ into: 0, rate: 1 }]);
    let fullest = 0;
    let tippedAt = NaN;
    let backAt = NaN;

    for (let t = 0; t < 8; t += 1 / 60) {
      tipping.step(1 / 60);
      fullest = Math.max(fullest, tipping.water[0]);

      if (isNaN(tippedAt) && tipping.tip[0] > 1.5) tippedAt = t;

      if (!isNaN(tippedAt) && isNaN(backAt) && tipping.tip[0] < 0.05) {
        backAt = t;
        // Empty, or near enough: what's run in since it came up.
        expect(tipping.water[0]).toBeLessThan(0.5);
      }
    }

    // 45 kg/m³ × 0.125 × 0.6 ≈ 3.4 kg at 1 kg/s, then most of a second
    // creeping over, and the better part of one more going.
    expect(tippedAt).toBeGreaterThan(3.4);
    expect(tippedAt).toBeLessThan(5.5);
    expect(fullest).toBeGreaterThan(3);
    // It fills a little more as it starts to lean, before it spills.
    expect(fullest).toBeLessThan(4.5);
    expect(backAt - tippedAt).toBeLessThan(2.5);
  });

  it("stays at rest, still, while it's filling", () => {
    const tipping = createTipping([lone], [{ into: 0, rate: 1 }]);

    for (let t = 0; t < 2; t += 1 / 60) tipping.step(1 / 60);

    expect(tipping.tip[0]).toBe(0);
    expect(tipping.water[0]).toBeCloseTo(2, 1);
  });

  it("pours on what it catches, less what lands while it's over", () => {
    const tipping = createTipping(
      [
        { ...lone, into: 1, caught: 1 },
        { ...lone, size: 0.6 },
      ],
      [{ into: 0, rate: 1.5 }]
    );

    const poured = [0, 0];
    const dt = 1 / 240;

    for (let t = 0; t < 60; t += dt) {
      tipping.step(dt);
      poured[0] += tipping.pour[0] * dt;
      poured[1] += tipping.pour[1] * dt;
    }

    // The feed's 90 kg, less what fell on the first while it was over
    // (about a third of the time: two of every five or six seconds).
    expect(poured[0]).toBeLessThan(90);
    expect(poured[0]).toBeGreaterThan(45);
    // The second's held some yet, and missed what came while it was over.
    expect(poured[1]).toBeLessThan(poured[0]);
    expect(poured[1]).toBeGreaterThan(poured[0] * 0.5);
  });
});

describe("the whole fountain running", () => {
  it("tips every one of its buckets inside three minutes", () => {
    const tipping = createTipping(BUCKETS, FEEDS);
    const tipped = new Set<number>();

    for (let t = 0; t < 180; t += 1 / 30) {
      tipping.step(1 / 30);
      BUCKETS.forEach((_, i) => tipping.tip[i] > 1.5 && tipped.add(i));
    }

    expect(tipped.size).toBe(BUCKETS.length);
  });
});
