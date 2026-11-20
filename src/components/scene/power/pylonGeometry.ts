import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  MeshStandardNodeMaterial,
  Vector3,
} from "three/webgpu";
import {
  attribute,
  cameraPosition,
  clamp,
  faceDirection,
  float,
  mix,
  normalGeometry,
  positionGeometry,
  transformNormalToView,
  uniform,
  varying,
} from "three/tsl";
import { pixelAngle, rotateY } from "../landmarks/common";
import {
  coverWithSteel,
  latticeHalfWidth,
  latticeSteel,
  latticeWiden,
} from "../landmarks/latticeGeometry";
import type {
  BridgeSpec,
  CageSpec,
  FrameSpec,
  PoleSpec,
  TowerSpec,
} from "./towers";

// Transmission towers and poles, as panels the lattice shader draws
// steelwork on (see ../landmarks/latticeGeometry.ts): a tower's a few dozen
// quads, and hundreds of them stand in the scene, instanced.
//
// A kind of tower is built once, in its own frame (x across the line, y up,
// z along it), with a body BODY tall. Each tower's own body height comes
// from the lidar, so every vertex carries `grow`: how it moves for each
// BODY the body's taller. The head rides up whole; the body stretches, its
// feet spreading to keep the legs' slope.
//
// Per vertex:
//   lattice  across its face from the centre line and along it, m; 1 for an
//            insulator (0 steel); 1 on the body (0 on the head)
//   frame    the face's half-widths at its two ends, its length, and how
//            many panels of bracing (0: a solid face)
//   widen    from its member's centre line to the vertex, for fattening
//            members too thin to see far off; and the bracing's width, m
//   grow     as above; and the legs' width, m

/** The body's height as built, m. */
export const BODY = 20;

/**
 * A panel of bracing is this tall for its face's width: squat, so the
 * steelwork's dense enough to read as a tower's.
 */
const PANEL = 0.7;

/** How far below the foot the legs run, so slopes can't show a gap. */
const FOOTING = 6;

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

/** How a member's drawn: lattice steel, or solid (no `leg`). */
interface Style {
  leg?: number;
  brace?: number;
  insulator?: boolean;
  /** How a vertex at `p` moves for each BODY the body's taller. */
  grow: (p: Vector3, centre: Vector3) => Vector3;
  body?: boolean;
}

/** The head moves up with the body's top. */
const rides = () => new Vector3(0, BODY, 0);

class Panels {
  private position: number[] = [];
  private normal: number[] = [];
  private lattice: number[] = [];
  private frame: number[] = [];
  private widen: number[] = [];
  private grow: number[] = [];
  private index: number[] = [];

  /**
   * One face of a member from `p0` to `p1`: `across` it, its half-width
   * goes from `half[0]` to `half[1]`, and it stands `out[0]` to `out[1]`
   * off the member's centre line along `normal`. `size` is what's kept
   * wide enough to see: the face's own half-widths unless given.
   */
  face(
    p0: Vector3,
    p1: Vector3,
    across: Vector3,
    half: [number, number],
    normal: Vector3,
    out: [number, number],
    style: Style,
    size = half
  ) {
    const length = p0.distanceTo(p1);
    const mean = half[0] + half[1];

    const panels =
      style.leg === undefined
        ? 0
        : Math.max(1, Math.round(length / mean / PANEL));

    const base = this.position.length / 3;

    for (const [t, side] of [
      [0, -1],
      [0, 1],
      [1, 1],
      [1, -1],
    ]) {
      const centre = p0.clone().lerp(p1, t);

      const p = centre
        .clone()
        .addScaledVector(normal, out[t])
        .addScaledVector(across, side * half[t]);

      const grow = style.grow(p, centre);
      this.position.push(p.x, p.y, p.z);
      this.normal.push(normal.x, normal.y, normal.z);
      this.lattice.push(
        side * half[t],
        t * length,
        style.insulator ? 1 : 0,
        style.body ? 1 : 0
      );
      this.frame.push(size[0], size[1], length, panels);
      this.widen.push(
        p.x - centre.x,
        p.y - centre.y,
        p.z - centre.z,
        style.brace ?? 0
      );
      this.grow.push(grow.x, grow.y, grow.z, style.leg ?? 0);
    }

    // Wound to face along `normal`: lighting flips it for the back.
    const front = across.clone().cross(p1.clone().sub(p0)).dot(normal) > 0;
    const [second, third] = front ? [1, 2] : [2, 1];
    this.index.push(
      base,
      base + second,
      base + third,
      base,
      base + (front ? 2 : 3),
      base + (front ? 3 : 2)
    );
  }

  /**
   * A four-sided member from `p0` to `p1`, `a` wide along `A` and `b` along
   * `B` at each end, m.
   */
  column(
    p0: Vector3,
    p1: Vector3,
    A: Vector3,
    a: [number, number],
    B: Vector3,
    b: [number, number],
    style: Style
  ) {
    const halves = (w: [number, number]): [number, number] => [
      Math.max(w[0] / 2, 0.04),
      Math.max(w[1] / 2, 0.04),
    ];

    for (const sign of [1, -1]) {
      const flip = (v: Vector3) => v.clone().multiplyScalar(sign);

      const off = (w: [number, number]): [number, number] => [
        w[0] / 2,
        w[1] / 2,
      ];

      this.face(p0, p1, A, halves(a), flip(B), off(b), style);
      this.face(p0, p1, B, halves(b), flip(A), off(a), style);
    }
  }

  /** A round member, solid: `d` across at each end, m. */
  tube(p0: Vector3, p1: Vector3, d: [number, number], style: Style) {
    const axis = p1.clone().sub(p0).normalize();
    const u = Math.abs(axis.y) > 0.9 ? X.clone() : Y.clone();
    u.addScaledVector(axis, -u.dot(axis)).normalize();
    const v = axis.clone().cross(u);
    const SIDES = 8;
    const chord = Math.tan(Math.PI / SIDES);

    for (let i = 0; i < SIDES; i++) {
      const angle = ((i + 0.5) / SIDES) * 2 * Math.PI;

      const normal = u
        .clone()
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(v, Math.sin(angle));

      const across = axis.clone().cross(normal);

      // Kept as wide as the tube, not as each of its faces.
      this.face(
        p0,
        p1,
        across,
        [(d[0] / 2) * chord, (d[1] / 2) * chord],
        normal,
        [d[0] / 2, d[1] / 2],
        style,
        [d[0] / 2, d[1] / 2]
      );
    }
  }

  /** An insulator string hanging `length` below `tip`: two crossed blades. */
  insulator(tip: Vector3, length: number) {
    if (length <= 0) return;
    const foot = tip.clone().addScaledVector(Y, -length);
    const style: Style = { insulator: true, grow: rides };
    const half: [number, number] = [0.18, 0.18];
    this.face(tip, foot, X, half, Z, [0, 0], style);
    this.face(tip, foot, Z, half, X, [0, 0], style);
  }

  build() {
    const geometry = new BufferGeometry();

    const set = (name: string, values: number[], size: number) =>
      geometry.setAttribute(name, new Float32BufferAttribute(values, size));

    set("position", this.position, 3);
    set("normal", this.normal, 3);
    set("lattice", this.lattice, 4);
    set("frame", this.frame, 4);
    set("widen", this.widen, 4);
    set("grow", this.grow, 4);
    geometry.setIndex(this.index);

    return geometry;
  }
}

const at = (x: number, y: number, z = 0) => new Vector3(x, y, z);

/**
 * A lattice body from under the ground to BODY: `waist` wide at its top,
 * its faces `spread` wider each metre down.
 */
function latticeBody(
  panels: Panels,
  { waist, spread, leg, brace }: CageSpec | BridgeSpec
) {
  const width = (y: number) => waist + spread * (BODY - y);

  panels.column(
    at(0, -FOOTING),
    at(0, BODY),
    X,
    [width(-FOOTING), waist],
    Z,
    [width(-FOOTING), waist],
    {
      leg,
      brace,
      body: true,
      // Taller, it's wider below the waist by the same slope.
      grow: (p) => {
        const beyond = 1 - waist / width(p.y);

        return new Vector3(p.x * beyond, p.y, p.z * beyond);
      },
    }
  );
}

function cageTower(spec: CageSpec) {
  const panels = new Panels();
  const { waist, crown, peak, head, leg, brace } = spec;
  const steel: Style = { leg, brace, grow: rides };
  const top = BODY + head;
  const shoulder = top - peak;

  latticeBody(panels, spec);
  panels.column(
    at(0, BODY),
    at(0, shoulder),
    X,
    [waist, crown],
    Z,
    [waist, crown],
    steel
  );
  panels.column(
    at(0, shoulder),
    at(0, top),
    X,
    [crown, 0.12],
    Z,
    [crown, 0.12],
    steel
  );

  /** The tower's width at a height: its cage, or the peak over it. */
  const width = (y: number) =>
    y > shoulder
      ? crown * ((top - y) / peak)
      : waist + (crown - waist) * ((y - BODY) / (shoulder - BODY));

  for (const arm of spec.arms) {
    const y = top - arm.below;
    const side = Math.sign(arm.x);
    const root = width(y);
    // Deep where it leaves the tower, its lower edge level.
    const depth = Math.min(Math.max(Math.abs(arm.x) * 0.22, 0.8), 1.8);

    panels.column(
      at(side * Math.max(root / 2 - 0.1, 0), y + depth / 2),
      at(arm.x, y + 0.08),
      Z,
      [Math.max(root, 0.6), 0.2],
      Y,
      [depth, 0.16],
      { leg: leg * 0.8, brace: brace * 0.8, grow: rides }
    );
    panels.insulator(at(arm.x, y), spec.insulator);
  }

  return panels.build();
}

function bridgeTower(spec: BridgeSpec) {
  const panels = new Panels();
  const { waist, limbs, bridge, head, leg, brace } = spec;
  const steel: Style = { leg, brace, grow: rides };
  const top = BODY + head;
  const beam = top - bridge;
  const reach = Math.max(...spec.arms.map((arm) => Math.abs(arm.x)));

  latticeBody(panels, spec);

  for (const side of [-1, 1]) {
    const foot = at((side * waist) / 4, BODY);
    const headOf = at(side * limbs, beam - 0.5);
    const lean = headOf.clone().sub(foot).normalize();
    // Square to the limb, in the plane it leans in.
    const square = new Vector3(lean.y, -lean.x, 0);

    panels.column(
      foot,
      headOf,
      Z,
      [waist * 0.6, 0.9],
      square,
      [waist * 0.6, 0.9],
      steel
    );
    // An earth peak over each limb.
    panels.column(
      at(side * limbs, beam + 0.5),
      at(side * limbs, top),
      X,
      [0.9, 0.12],
      Z,
      [0.9, 0.12],
      steel
    );
  }

  panels.column(
    at(-reach - 0.4, beam),
    at(reach + 0.4, beam),
    Z,
    [1.1, 1.1],
    Y,
    [1, 1],
    steel
  );

  for (const arm of spec.arms) {
    panels.insulator(at(arm.x, top - arm.below), spec.insulator);
  }

  return panels.build();
}

/**
 * A pole's shaft about `x`: from under the ground to BODY as its body,
 * then on up through the head. `top` across at the very top, `taper` wider
 * each metre down.
 */
function shaft(
  panels: Panels,
  x: number,
  { top, taper, head }: PoleSpec | FrameSpec
) {
  const across = (y: number) => top + taper * (BODY + head - y);

  panels.tube(at(x, -FOOTING), at(x, BODY), [across(-FOOTING), across(BODY)], {
    body: true,
    grow: (p, centre) => {
      const beyond = 1 - across(BODY) / across(p.y);

      return new Vector3(
        (p.x - centre.x) * beyond,
        p.y,
        (p.z - centre.z) * beyond
      );
    },
  });
  panels.tube(at(x, BODY), at(x, BODY + head), [across(BODY), top], {
    grow: rides,
  });
}

function pole(spec: PoleSpec) {
  const panels = new Panels();
  const top = BODY + spec.head;

  shaft(panels, 0, spec);

  for (const arm of spec.arms) {
    const y = top - arm.below;
    panels.column(
      at(0, y + 0.15),
      at(arm.x, y + 0.06),
      Z,
      [0.3, 0.14],
      Y,
      [0.3, 0.12],
      {
        grow: rides,
      }
    );
    panels.insulator(at(arm.x, y), spec.insulator);
  }

  return panels.build();
}

function frame(spec: FrameSpec) {
  const panels = new Panels();
  const top = BODY + spec.head;
  const beam = top - spec.head / 2;

  shaft(panels, -spec.posts, spec);
  shaft(panels, spec.posts, spec);
  panels.column(
    at(-spec.beam, beam),
    at(spec.beam, beam),
    Z,
    [0.5, 0.5],
    Y,
    [0.6, 0.6],
    {
      grow: rides,
    }
  );

  for (const arm of spec.arms) {
    panels.insulator(at(arm.x, top - arm.below), spec.insulator);
  }

  return panels.build();
}

/** A kind of tower in its own frame, its foot at the origin. */
export function createTowerGeometry(spec: TowerSpec) {
  switch (spec.form) {
    case "cage":
      return cageTower(spec);
    case "bridge":
      return bridgeTower(spec);
    case "pole":
      return pole(spec);
    case "frame":
      return frame(spec);
  }
}

/**
 * Galvanised steel gone dull, and glass insulators: both darker than they
 * are, so a tower stands out from the pale hills behind it as a real one
 * does from a bright sky.
 */
const STEEL = "#5c6264";
const INSULATOR = "#3a4442";

/** Legs and bracing are drawn at least this many pixels wide. */
const LEG_PIXELS = 2;
const BRACE_PIXELS = 1.3;

/** But no more than this many times their own width. */
const BOLDEST = 3.5;

/**
 * The one material every tower's drawn with. Each stands by its instance's
 * `place` (world position of its foot, and its turn about the vertical)
 * and `tall` (its body's height over BODY). `msaa`: whether the canvas
 * multisamples, for the lattice's partial coverage.
 */
export function createTowerMaterial(msaa: boolean) {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.65,
    metalness: 0,
    side: DoubleSide,
  });

  const place = attribute("place", "vec4");
  const tall = attribute("tall", "float");
  const lattice = attribute("lattice", "vec4");
  const frame = attribute("frame", "vec4");
  const widenBy = attribute("widen", "vec4");
  const grow = attribute("grow", "vec4");

  const grown = positionGeometry.add(grow.xyz.mul(tall.sub(1)));
  const world = rotateY(grown, place.w).add(place.xyz);

  // Passed down, as `widen` is: they're per vertex, and the fragment stage
  // would work them out again for every pixel.
  const metresPerPixel: any = varying(
    cameraPosition.distance(world).mul(pixelAngle)
  );

  // Far off, fatten each member about its centre line to stay a pixel wide
  // (it'd drop out between samples) and spread its coverage thinner to
  // match.
  const widen: any = varying(
    latticeWiden(latticeHalfWidth(lattice, frame), metresPerPixel)
  );

  material.positionNode = rotateY(
    grown.add(widenBy.xyz.mul(widen.sub(1))),
    place.w
  ).add(place.xyz);
  // The shadow pass sees the tower from the sun: true size.
  material.castShadowPositionNode = world;

  const normal: any = varying(
    transformNormalToView(rotateY(normalGeometry, place.w))
  );

  material.normalNode = normal.normalize().mul(faceDirection);

  // A stretched body's bracing is drawn in the body's own metres: thin it
  // to match.
  const stretch = mix(float(1), tall, lattice.w);

  // Steel a few pixels' worth away is a pixel wide and faint, and a tower
  // of it a ghost: so each member's drawn `pixels` wide at the least, until
  // that's BOLDEST times what it is, and thins out from there.
  const bold = (width, pixels: number) =>
    clamp(metresPerPixel.mul(pixels), width, width.mul(BOLDEST)).div(stretch);

  const steel = frame.w
    .lessThan(0.5)
    .select(
      float(1),
      latticeSteel(
        lattice,
        frame,
        bold(grow.w, LEG_PIXELS),
        bold(widenBy.w, BRACE_PIXELS)
      )
    );

  material.colorNode = mix(
    uniform(new Color(STEEL)),
    uniform(new Color(INSULATOR)),
    lattice.z
  );
  coverWithSteel(material, steel, steel.div(widen), msaa);

  return material;
}
