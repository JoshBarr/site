import { describe, expect, it } from "vitest";
import { flocksOf, HABITS } from "../../src/components/scene/birds/habits";
import type { Form } from "../../src/components/scene/birds/model";
import { OWN, ownOf } from "../../src/components/scene/birds/species";
import type { BirdsResponse } from "../../src/pages/api/birds";

// The birds with shapes of their own: each a closed body seen from
// outside, wings in two pieces that hinge clear of it, in greys; and each
// with the marks it's known by.

interface Triangle {
  wing: boolean;
  corners: [number, number, number][];
  /** Its face's normal, by its winding; not unit length. */
  normal: [number, number, number];
  middle: [number, number, number];
  /** Its grey, 0 black to 1 white. */
  tone: number;
}

function trianglesOf({ geometry }: Form) {
  const position = geometry.getAttribute("position");
  const part = geometry.getAttribute("part");
  const paint = geometry.getAttribute("paint");
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

    for (const k of [1, 2]) {
      expect(part.getX(i + k)).toBe(part.getX(i));
      expect(paint.getX(i + k)).toBe(paint.getX(i));
    }

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

  return triangles;
}

/** A triangle's area as seen from straight above or below. */
const plan = ({ normal }: Triangle) => Math.abs(normal[1]) / 2;

const sum = (of: Triangle[], measure: (t: Triangle) => number) =>
  of.reduce((total, t) => total + measure(t), 0);

const mean = (of: Triangle[]) => sum(of, ({ tone }) => tone) / of.length;

const forms = OWN.map((own) => ({ ...own, shape: own.form() }));
const named = (name: string) => trianglesOf(forms[ownOf(name)].shape);

describe.each(forms)("the $name's shape", ({ shape }) => {
  const triangles = trianglesOf(shape);
  const wings = triangles.filter(({ wing }) => wing);

  it("is a wingspan of one across, the same either side", () => {
    shape.geometry.computeBoundingBox();
    const { min, max } = shape.geometry.boundingBox!;

    expect(max.x - min.x).toBeCloseTo(1, 1);
    expect(max.x).toBeCloseTo(-min.x);
  });

  it("is in greys, one to a vertex", () => {
    expect(shape.geometry.getAttribute("paint").itemSize).toBe(1);

    for (const { tone } of triangles) {
      expect(tone).toBeGreaterThan(0);
      expect(tone).toBeLessThan(1);
    }
  });

  it("has wings that swing from the shoulder out, bent at a wrist", () => {
    expect(wings.length).toBeGreaterThan(0);
    expect(shape.wrist).toBeGreaterThan(shape.shoulder + 0.1);
    expect(shape.wrist).toBeLessThan(0.4);

    let arm = 0;
    let hand = 0;

    for (const { corners } of wings) {
      for (const corner of corners) {
        const out = Math.abs(corner[0]);

        expect(out).toBeGreaterThanOrEqual(shape.shoulder - 1e-6);

        if (out > shape.wrist + 1e-4) hand++;
        else arm++;
      }
    }

    expect(arm).toBeGreaterThan(0);
    expect(hand).toBeGreaterThan(0);
  });

  it("has each wing as a sheet facing up over one facing down", () => {
    const up = wings.filter(({ normal }) => normal[1] > 0);
    const down = wings.filter(({ normal }) => normal[1] < 0);

    expect(up.length + down.length).toBe(wings.length);
    expect(sum(up, plan)).toBeCloseTo(sum(down, plan), 4);
  });

  it("has a closed body, facing outward", () => {
    // The volume its faces enclose, by their winding: the tail's two
    // sheets, back to back, enclose none. Inside out, it'd be negative.
    let volume = 0;

    for (const { wing, corners, normal } of triangles) {
      if (wing) continue;

      const [a] = corners;
      volume += (a[0] * normal[0] + a[1] * normal[1] + a[2] * normal[2]) / 6;
    }

    expect(volume).toBeGreaterThan(0.0003);
    expect(volume).toBeLessThan(0.015);
  });
});

describe("what each is known by", () => {
  /** The body's faces within `z`, on top or underneath. */
  const body = (
    triangles: Triangle[],
    from: number,
    to: number,
    side: "top" | "under"
  ) =>
    triangles.filter(
      ({ wing, middle, normal }) =>
        !wing &&
        middle[2] > from &&
        middle[2] < to &&
        (side === "top" ? normal[1] > 0 : normal[1] < 0) &&
        Math.abs(normal[1]) > Math.abs(normal[0])
    );

  it("a tūī: dark, with white tufts at its throat and a white patch on each wing", () => {
    const tui = named("Tui");
    const above = tui.filter(({ wing, normal }) => wing && normal[1] > 0);
    const patch = above.filter(({ tone }) => tone > 0.6);

    expect(mean(body(tui, -0.1, 0.15, "top"))).toBeLessThan(0.1);
    expect(patch.length).toBeGreaterThan(0);
    expect(sum(patch, plan) / sum(above, plan)).toBeLessThan(0.15);

    const tufts = tui.filter(
      ({ wing, tone, middle }) => !wing && tone > 0.8 && middle[1] < 0
    );

    // Two of them, eight faces each, under the throat.
    expect(tufts).toHaveLength(16);

    for (const { middle } of tufts) {
      expect(middle[2]).toBeGreaterThan(0.18);
      expect(middle[2]).toBeLessThan(0.26);
    }
  });

  it("a goose: a long black neck, a white chinstrap, and white at the root of a black tail", () => {
    const goose = named("Canada Goose");

    const neck = goose.filter(
      ({ wing, middle }) => !wing && middle[2] > 0.16 && middle[2] < 0.25
    );

    expect(neck.length).toBeGreaterThan(0);

    for (const face of neck) {
      expect(face.tone).toBeLessThan(0.1);
      // Thin: a fifth as wide as the body.
      expect(Math.abs(face.middle[0])).toBeLessThan(0.02);
    }

    const strap = goose.filter(
      ({ wing, tone, middle }) => !wing && tone > 0.8 && middle[2] > 0.25
    );

    expect(strap.length).toBeGreaterThan(0);

    for (const { middle } of strap) expect(middle[1]).toBeLessThan(0.025);

    expect(mean(body(goose, -0.18, -0.155, "top"))).toBeGreaterThan(0.8);
    expect(mean(body(goose, -0.15, -0.11, "top"))).toBeLessThan(0.1);
  });

  it("a tākapu: white, long narrow wings black behind and at the tips", () => {
    const gannet = named("Australasian Gannet");
    const above = gannet.filter(({ wing, normal }) => wing && normal[1] > 0);
    const black = above.filter(({ tone }) => tone < 0.1);

    expect(mean(body(gannet, -0.1, 0.1, "top"))).toBeGreaterThan(0.85);
    // Narrow: a seventh of the span from front to back at most.
    expect(sum(above, plan)).toBeLessThan(0.1);
    expect(sum(black, plan) / sum(above, plan)).toBeGreaterThan(0.4);

    // Everything white on the wing is in front, or in at the arm.
    for (const { tone, middle } of above) {
      if (Math.abs(middle[0]) > 0.4) expect(tone).toBeLessThan(0.1);
    }
  });

  it("a rock pigeon: two dark bars across each wing, in to the wrist, and a white rump", () => {
    const { shape } = forms[ownOf("Rock Pigeon")];
    const pigeon = trianglesOf(shape);

    const bars = pigeon.filter(
      ({ wing, normal, tone }) => wing && normal[1] > 0 && tone < 0.1
    );

    expect(bars.length).toBeGreaterThan(0);

    for (const { corners } of bars) {
      for (const corner of corners) {
        expect(Math.abs(corner[0])).toBeLessThanOrEqual(shape.wrist + 1e-6);
      }
    }

    // Two of them: going back along the wing, dark twice.
    const forward = [...new Set(bars.map(({ middle }) => middle[2] > 0))];

    expect(forward).toHaveLength(2);

    // The rump: white over the top, between a grey back and a grey tail.
    const tones = (from: number, to: number) =>
      body(pigeon, from, to, "top").map(({ tone }) => tone);

    expect(Math.max(...tones(-0.1, -0.04))).toBeGreaterThan(0.8);
    expect(Math.max(...tones(-0.04, 0.1))).toBeLessThan(0.5);
    expect(Math.max(...tones(-0.14, -0.1))).toBeLessThan(0.5);
  });

  it("a heron: its legs out behind past its tail, and a white face", () => {
    const { shape } = forms[ownOf("White-faced Heron")];
    const heron = trianglesOf(shape);
    const wings = heron.filter(({ wing }) => wing);
    const rest = heron.filter(({ wing }) => !wing);
    const back = Math.min(...rest.map(({ middle }) => middle[2]));
    const tail = Math.min(...wings.map(({ middle }) => middle[2]));

    // The feet are well behind anything else of it.
    expect(back).toBeLessThan(-0.33);
    expect(back).toBeLessThan(tail - 0.2);

    const face = rest.filter(
      ({ tone, middle }) => tone > 0.8 && middle[2] > 0.2
    );

    expect(face.length).toBeGreaterThan(0);
  });
});

describe("a flock of a kind with its own shape", () => {
  type Site = BirdsResponse["sites"][number];

  const site = (kind: Site["kind"]): Site => ({
    kind,
    species: ["one"],
    position: [1747100, 5421304],
    radius: 200,
    size: 4,
    peak: 4,
    weight: 2,
    seen: 4,
    last: Date.parse("2026-11-23T23:00:00Z"),
  });

  const flock = (kind: Site["kind"], name: string) =>
    flocksOf(
      {
        sites: [site(kind)],
        species: { one: { name, sci: "", kind } },
      },
      (e, n) => [e, -n]
    )[0];

  it("is found by eBird's name for it, whatever's in brackets after", () => {
    expect(ownOf("Rock Pigeon")).toBeGreaterThanOrEqual(0);
    expect(flock("pigeon", "Rock Pigeon (Feral Pigeon)").name).toBe(
      "Rock Pigeon"
    );

    for (const plain of ["Kelp Gull", "Eurasian Blackbird", "House Sparrow"]) {
      expect(ownOf(plain)).toBe(-1);
    }
  });

  it("is its own size and beats its wings its own way, the rest as its kind", () => {
    const goose = flock("waterfowl", "Canada Goose");
    const duck = flock("waterfowl", "Mallard");
    const heron = flock("wader", "White-faced Heron");
    const pigeon = flock("pigeon", "Rock Pigeon (Feral Pigeon)");
    const kereru = flock("pigeon", "New Zealand Pigeon");

    expect(duck.habit).toBe(HABITS.waterfowl);
    expect(goose.habit.span).toBeGreaterThan(duck.habit.span * 1.5);
    expect(goose.habit.beat).toBeLessThan(duck.habit.beat);
    expect(goose.habit.speed).toBe(duck.habit.speed);
    expect(heron.habit.beat).toBeLessThan(3);
    expect(heron.habit.span).toBeGreaterThan(1);
    expect(kereru.habit).toBe(HABITS.pigeon);
    expect(pigeon.habit.span).toBeLessThan(kereru.habit.span);
    expect(pigeon.habit.beat).toBe(kereru.habit.beat);
  });
});
