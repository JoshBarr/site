import { BufferAttribute, BufferGeometry, Color } from "three/webgpu";
import type { Crossing } from "./crossingWatch";
import { RAIL_TOP } from "./network";

// A level crossing's hardware: the mast with its lights, sign, bell and
// barrier arm, built once and instanced; and the decks that carry each road
// across the tracks, all in one mesh.
//
// A mast is built in its own frame: x toward the middle of the road (the
// way its arm reaches), y up from the ground, z at those coming along the
// road. Per vertex, `part` says what it's made of and `swing` whether it's
// on the arm (x) and how far along it (y, 0..1): arm vertices are placed
// from the pivot, and the shader lays them out to each arm's length and
// swings them up.
//
// Every size here is a guess at the usual KiwiRail arrangement, drawn a
// little stout so it reads from a few hundred metres.

/** Parts, for the `part` attribute. */
const POST = 0;
export const BOARD = 1;
export const BLACK = 2;

/** The two lamps, which flash in turn. */
export const LAMP_A = 3;
export const LAMP_B = 4;
export const ARM = 5;

/**
 * Where the arm turns, in the mast's frame, m: in front of the post, so a
 * raised arm stands between the lamps, not over one.
 */
export const PIVOT: [number, number, number] = [0, 1.1, 0.24];

/** The lamps' height, and how far each is from the post, m. */
export const LAMP_HEIGHT = 2.55;
export const LAMP_OUT = 0.42;

const POST_HALF = 0.08;
const POST_HEIGHT = 4.5;

/** The crossbuck's boards: long, wide, and how high their middle is. */
const BOARD_LENGTH = 1.5;
const BOARD_WIDTH = 0.24;
const BOARD_HEIGHT = 3.6;

/** The lamps' black backgrounds and their lenses, radius. */
const TARGET = 0.34;
const LENS = 0.15;

/** The arm's section: half its depth and thickness. */
const ARM_HALF = 0.09;
const ARM_THICK = 0.04;

/** Behind the pivot, the arm's counterweight, m. */
const COUNTERWEIGHT = 0.7;

type V = [number, number, number];

class Builder {
  position: number[] = [];
  normal: number[] = [];
  part: number[] = [];
  swing: number[] = [];

  /** A quad a, b, c, d of `part`, facing `normal`; `along` the arm, if on it. */
  quad(part: number, normal: V, corners: [V, V, V, V], along?: number[]) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      this.position.push(...corners[i]);
      this.normal.push(...normal);
      this.part.push(part);
      this.swing.push(along ? 1 : 0, along?.[i] ?? 0);
    }
  }

  /**
   * A box from `lo` to `hi`. On the arm, `reach` is how far along it the
   * low and high x ends are (0..1), beyond their own x.
   */
  box(part: number, lo: V, hi: V, reach?: [number, number]) {
    // A corner by which end it's at on each axis, 0 or 1.
    const face = (normal: V, ends: [number, number, number][]) =>
      this.quad(
        part,
        normal,
        // SAFETY: four ends in, four corners out.
        ends.map(([i, j, k]): V => [
          i ? hi[0] : lo[0],
          j ? hi[1] : lo[1],
          k ? hi[2] : lo[2],
        ]) as [V, V, V, V],
        reach && ends.map(([i]) => reach[i])
      );

    face(
      [0, 0, 1],
      [
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ]
    );
    face(
      [0, 0, -1],
      [
        [1, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
      ]
    );
    face(
      [1, 0, 0],
      [
        [1, 0, 1],
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
      ]
    );
    face(
      [-1, 0, 0],
      [
        [0, 0, 0],
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 0],
      ]
    );
    face(
      [0, 1, 0],
      [
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 0],
        [0, 1, 0],
      ]
    );
    face(
      [0, -1, 0],
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1],
      ]
    );
  }

  /** An eight-sided disc facing along z (`face` 1 or -1), as a fan of quads. */
  disc(part: number, [cx, cy, cz]: V, radius: number, face: number) {
    const rim = (k: number): V => [
      cx + Math.cos((k * Math.PI) / 4) * radius,
      cy + Math.sin((k * Math.PI) / 4) * radius,
      cz,
    ];

    for (let k = 0; k < 8; k += 2) {
      this.quad(
        part,
        [0, 0, face],
        [[cx, cy, cz], rim(k), rim(k + 1), rim(k + 2)]
      );
    }
  }

  build() {
    const geometry = new BufferGeometry();

    const set = (name: string, values: number[], size: number) =>
      geometry.setAttribute(
        name,
        new BufferAttribute(new Float32Array(values), size)
      );

    set("position", this.position, 3);
    set("normal", this.normal, 3);
    set("part", this.part, 1);
    set("swing", this.swing, 2);

    return geometry;
  }
}

/**
 * A mast: post, crossbuck, a pair of lamps facing each way, a bell on top,
 * the barrier's housing, and an arm a unit long (see the top of the file).
 */
export function createMastGeometry() {
  const b = new Builder();
  const p = POST_HALF;

  b.box(POST, [-p, 0, -p], [p, POST_HEIGHT, p]);
  // The bell.
  b.box(POST, [-0.13, POST_HEIGHT, -0.13], [0.13, POST_HEIGHT + 0.22, 0.13]);
  // The barrier's machine.
  b.box(POST, [-0.2, 0.8, -0.18], [0.2, 1.4, 0.18]);

  // The crossbuck: two boards crossed, read from either side.
  for (const lean of [1, -1]) {
    const angle = (lean * Math.PI) / 4;
    const [ax, ay] = [Math.cos(angle), Math.sin(angle)];
    const l = BOARD_LENGTH / 2;
    const w = BOARD_WIDTH / 2;

    const corner = (along: number, across: number, z: number): V => [
      ax * along * l - ay * across * w,
      BOARD_HEIGHT + ay * along * l + ax * across * w,
      z,
    ];

    for (const face of [1, -1]) {
      const z = face * (p + 0.02 + (lean > 0 ? 0 : 0.01));

      b.quad(
        BOARD,
        [0, 0, face],
        [corner(-1, -1, z), corner(1, -1, z), corner(1, 1, z), corner(-1, 1, z)]
      );
    }
  }

  // The lamps: side by side on a bar, a pair facing each way.
  b.box(
    BLACK,
    [-LAMP_OUT, LAMP_HEIGHT - 0.05, -0.06],
    [LAMP_OUT, LAMP_HEIGHT + 0.05, 0.06]
  );

  for (const face of [1, -1]) {
    for (const [side, lamp] of [
      [-1, LAMP_A],
      [1, LAMP_B],
    ]) {
      const x = side * LAMP_OUT;

      b.disc(BLACK, [x, LAMP_HEIGHT, face * (p + 0.05)], TARGET, face);
      b.disc(lamp, [x, LAMP_HEIGHT, face * (p + 0.08)], LENS, face);
    }
  }

  // The arm, from the pivot: its length along +x comes from `swing`.
  b.box(ARM, [0, -ARM_HALF, -ARM_THICK], [0, ARM_HALF, ARM_THICK], [0, 1]);
  b.box(
    BLACK,
    [-COUNTERWEIGHT, -0.13, -ARM_THICK * 1.5],
    [0, 0.13, ARM_THICK * 1.5],
    [0, 0]
  );

  return b.build();
}

// --- Decks. ---

/** From a track's centre line to where its ballast meets the ground, m. */
const BED_HALF = 2.3;

/** Over the railhead, m: the deck's flush with it, the rails let in. */
const OVER_RAIL = 0.03;

/** Each ramp from the deck down to the road, m; and a path's. */
const RAMP = 6;
const PATH_RAMP = 3;

/** The ramps' ends are sunk this far into the ground, m. */
const SUNK = 0.12;

/** The deck's sides hang this far down, m, closing the gap under it. */
const SKIRT = 1.5;

/** Asphalt, as the streets are painted on the terrain; and a path's concrete. */
const ASPHALT = new Color(0.07, 0.07, 0.07);
const CONCRETE = new Color(0.32, 0.32, 0.31);

/**
 * From a crossing's middle along its road to where the deck's flat top
 * ends, m: past the outermost track's ballast, across the whole road
 * however askew it crosses.
 */
export function deckHalf({ spread, half, square }: Crossing) {
  const askew = Math.sqrt(1 - square * square) / square;

  return spread + BED_HALF / square + half * askew;
}

/**
 * Every crossing's deck: the road carried over the tracks at the railhead,
 * ramped down to the ground at each end.
 */
export function createDeckGeometry(crossings: Crossing[]) {
  const position: number[] = [];
  const color: number[] = [];

  for (const crossing of crossings) {
    const { x, y, z, road, half, ends, path } = crossing;
    const across: [number, number] = [-road[1], road[0]];
    const top = y + RAIL_TOP + OVER_RAIL;
    const flat = deckHalf(crossing);
    const tone = path ? CONCRETE : ASPHALT;
    const ramp = path ? PATH_RAMP : RAMP;

    // Sections along the road: [how far, how high].
    const sections: [number, number][] = [
      [-flat - ramp, ends[1] - SUNK],
      [-flat, top],
      [flat, top],
      [flat + ramp, ends[0] - SUNK],
    ];

    const at = (along: number, side: number, height: number): V => [
      x + road[0] * along + across[0] * side * half,
      height,
      z + road[1] * along + across[1] * side * half,
    ];

    const quad = (a: V, b: V, c: V, d: V) => {
      position.push(...a, ...b, ...c, ...a, ...c, ...d);

      for (let i = 0; i < 6; i++) color.push(tone.r, tone.g, tone.b);
    };

    for (let k = 1; k < sections.length; k++) {
      const [u0, h0] = sections[k - 1];
      const [u1, h1] = sections[k];

      quad(at(u0, 1, h0), at(u1, 1, h1), at(u1, -1, h1), at(u0, -1, h0));

      for (const side of [1, -1]) {
        quad(
          at(u0, side, h0),
          at(u0, side, h0 - SKIRT),
          at(u1, side, h1 - SKIRT),
          at(u1, side, h1)
        );
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(position), 3)
  );
  geometry.setAttribute(
    "color",
    new BufferAttribute(new Float32Array(color), 3)
  );
  geometry.computeVertexNormals();

  return geometry;
}
