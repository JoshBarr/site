import { describe, expect, it } from "vitest";
import { flocksOf, HABITS } from "../../src/components/scene/birds/habits";
import {
  isKaka,
  KAKA_BEAT,
  KAKA_SPAN,
  kakaForm,
} from "../../src/components/scene/birds/kaka";
import type { BirdsResponse } from "../../src/pages/api/birds";

// The kākā's own shape: a closed body seen from outside, wings that hinge
// clear of it, and in greys: dark above with a pale crown, paler and
// barred under the wing.

const { geometry, shoulder } = kakaForm();
const position = geometry.getAttribute("position");
const part = geometry.getAttribute("part");
const paint = geometry.getAttribute("paint");

interface Triangle {
  wing: boolean;
  corners: [number, number, number][];
  /** Its face's normal, by its winding; not unit length. */
  normal: [number, number, number];
  middle: [number, number, number];
  /** Its grey, 0 black to 1 white. */
  tone: number;
}

const triangles: Triangle[] = [];

for (let i = 0; i < position.count; i += 3) {
  const corners = [0, 1, 2].map((k): [number, number, number] => [
    position.getX(i + k),
    position.getY(i + k),
    position.getZ(i + k),
  ]);

  const [a, b, c] = corners;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];

  triangles.push({
    wing: part.getX(i) === 1,
    corners,
    normal: [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ],
    middle: [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ],
    tone: paint.getX(i),
  });
}

/** A triangle's area as seen from straight above or below. */
const plan = ({ normal }: Triangle) => Math.abs(normal[1]) / 2;

const sum = (of: Triangle[], measure: (t: Triangle) => number) =>
  of.reduce((total, t) => total + measure(t), 0);

const wings = triangles.filter(({ wing }) => wing);

const site = (species: string): BirdsResponse["sites"][number] => ({
  kind: "parrot",
  species: [species],
  position: [1747100, 5421304],
  radius: 200,
  size: 4,
  peak: 4,
  weight: 2,
  seen: 4,
  last: Date.parse("2026-11-23T23:00:00Z"),
});

describe("the kākā's shape", () => {
  it("is the kākā's alone", () => {
    expect(isKaka("New Zealand Kaka")).toBe(true);
    expect(isKaka("Eastern Rosella")).toBe(false);
    expect(isKaka("Red-crowned Kakariki")).toBe(false);
  });

  it("is a wingspan of one across, and half that long", () => {
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox!;

    expect(max.x - min.x).toBeCloseTo(1, 2);
    expect(max.x).toBeCloseTo(-min.x);
    // 42 cm or so of an 85 cm span.
    expect(max.z - min.z).toBeGreaterThan(0.46);
    expect(max.z - min.z).toBeLessThan(0.56);
  });

  it("paints in greys, one to a vertex", () => {
    expect(paint.itemSize).toBe(1);

    for (const { tone } of triangles) {
      expect(tone).toBeGreaterThan(0);
      expect(tone).toBeLessThan(1);
    }
  });

  it("paints every corner of a triangle alike, and as a wing or not", () => {
    for (let i = 0; i < position.count; i += 3) {
      for (const k of [1, 2]) {
        expect(part.getX(i + k)).toBe(part.getX(i));
        expect(paint.getX(i + k)).toBe(paint.getX(i));
      }
    }
  });

  it("has wings that swing from the shoulder out, not through the body", () => {
    expect(wings.length).toBeGreaterThan(0);

    for (const { corners } of wings) {
      for (const corner of corners) {
        expect(Math.abs(corner[0])).toBeGreaterThanOrEqual(shoulder - 1e-6);
      }
    }
  });

  it("has each wing as a sheet facing up over one facing down", () => {
    const up = wings.filter(({ normal }) => normal[1] > 0);
    const down = wings.filter(({ normal }) => normal[1] < 0);

    expect(up.length + down.length).toBe(wings.length);

    // The same wing from either side, however it's cut up into feathers.
    expect(sum(up, plan)).toBeCloseTo(sum(down, plan), 4);

    // Broad: a fifth of the span or so from front to back, all along.
    expect(sum(up, plan)).toBeGreaterThan(0.17);
  });

  it("spreads its outer primaries like fingers, with sky between", () => {
    const over = wings.filter(({ normal }) => normal[1] > 0);

    /** Whether there's wing at x, z, seen from above. */
    const covered = (x: number, z: number) =>
      over.some(({ corners: [a, b, c] }) => {
        const side = (p: number[], q: number[]) =>
          (q[0] - p[0]) * (z - p[2]) - (q[2] - p[2]) * (x - p[0]);

        const [d, e, f] = [side(a, b), side(b, c), side(c, a)];

        return (d >= 0 && e >= 0 && f >= 0) || (d <= 0 && e <= 0 && f <= 0);
      });

    /** Stretches of wing met going from one point to another. */
    const crossed = (from: [number, number], to: [number, number]) => {
      let runs = 0;
      let on = false;

      for (let i = 0; i <= 400; i++) {
        const t = i / 400;

        const now = covered(
          from[0] + (to[0] - from[0]) * t,
          from[1] + (to[1] - from[1]) * t
        );

        if (now && !on) runs++;
        on = now;
      }

      return runs;
    };

    // Across the wingtip, just in from the feathers' ends: four or five
    // of them apart.
    expect(crossed([0.41, -0.115], [0.5, 0.03])).toBeGreaterThanOrEqual(4);
    // Across the inner wing: one stretch, unbroken.
    expect(crossed([0.15, 0.2], [0.15, -0.2])).toBe(1);
  });

  it("has a body facing outward, and a stout one", () => {
    // The volume its faces enclose, by their winding: the tail's two
    // sheets, back to back, enclose none. Inside out, it'd be negative.
    let volume = 0;

    for (const { wing, corners, normal } of triangles) {
      if (wing) continue;

      const [a] = corners;
      volume += (a[0] * normal[0] + a[1] * normal[1] + a[2] * normal[2]) / 6;
    }

    expect(volume).toBeGreaterThan(0.0015);
    expect(volume).toBeLessThan(0.004);
  });

  it("is dark above, with a pale crown", () => {
    const above = triangles.filter(({ normal }) => normal[1] > 0);

    const crown = above.filter(
      ({ wing, middle }) => !wing && middle[2] > 0.16 && middle[1] > 0.045
    );

    expect(crown.length).toBeGreaterThan(0);

    for (const face of crown) expect(face.tone).toBeGreaterThan(0.4);

    const over = wings.filter(({ normal }) => normal[1] > 0);

    for (const face of over) expect(face.tone).toBeLessThan(0.2);
  });

  it("is paler under the wing than over it, and barred behind its coverts", () => {
    const over = wings.filter(({ normal }) => normal[1] > 0);
    const under = wings.filter(({ normal }) => normal[1] < 0);

    // Three greys below: the bars' dark, the coverts', and the bars' pale.
    const [dark, lining, pale] = [...new Set(under.map(({ tone }) => tone))]
      .sort((a, b) => a - b)
      .concat(Number.NaN, Number.NaN);

    expect(new Set(under.map(({ tone }) => tone)).size).toBe(3);
    expect(dark).toBeGreaterThan(Math.max(...over.map(({ tone }) => tone)));
    expect(pale).toBeGreaterThan(dark * 2);

    // The coverts: a third of the wing or so, all of it toward the front.
    const coverts = under.filter(({ tone }) => tone === lining);

    expect(sum(coverts, plan) / sum(under, plan)).toBeGreaterThan(0.25);
    expect(sum(coverts, plan) / sum(under, plan)).toBeLessThan(0.45);

    for (const face of coverts) expect(face.middle[2]).toBeGreaterThan(0);
  });
});

describe("a flock of kākā", () => {
  const species = {
    kaka: { name: "New Zealand Kaka", sci: "Nestor meridionalis" },
    rosella: { name: "Eastern Rosella", sci: "Platycercus eximius" },
  };

  const flocks = (first: keyof typeof species) =>
    flocksOf(
      {
        sites: [site(first)],
        species: {
          [first]: { ...species[first], kind: "parrot" },
        },
      },
      (e, n) => [e, -n]
    );

  it("is as wide across the wings as kākā are, not as parrots mostly are", () => {
    const [kaka] = flocks("kaka");
    const [rosellas] = flocks("rosella");

    expect(kaka.label).toBe("Kākā");
    expect(kaka.habit.span).toBe(KAKA_SPAN);
    expect(kaka.habit.beat).toBe(KAKA_BEAT);
    expect(kaka.habit.beat).toBeLessThan(rosellas.habit.beat);
    expect(kaka.habit.speed).toBe(HABITS.parrot?.speed);
    expect(rosellas.habit).toBe(HABITS.parrot);
  });
});
