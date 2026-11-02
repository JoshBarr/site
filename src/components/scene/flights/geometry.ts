import { BufferAttribute, BufferGeometry } from "three/webgpu";

// Unit aircraft, scaled by length. Nose toward -z, from z = -0.5 to 0.5; wings
// along x; the fuselage centred on y = 0. Flat shaded, with a `tail`
// attribute of 1 on the fin so it can carry its own colour.

type Vec = [number, number, number];

class Builder {
  position: number[] = [];
  tail: number[] = [];

  /** A triangle, wound to face away from `inside`. */
  triangle(inside: Vec, tail: number, a: Vec, b: Vec, c: Vec) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];

    const normal = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];

    const out = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3 - inside[k]);
    const facing = normal[0] * out[0] + normal[1] * out[1] + normal[2] * out[2];

    for (const p of facing < 0 ? [a, c, b] : [a, b, c])
      this.position.push(...p);
    this.tail.push(tail, tail, tail);
  }

  /**
   * A tube along z through rings of [z, radius, y], eight-sided, closed at
   * both ends.
   */
  tube(rings: [number, number, number][], x = 0, tail = 0) {
    const sides = 8;

    const ring = ([z, r, y]: [number, number, number]) =>
      Array.from({ length: sides }, (_, i): Vec => {
        const angle = ((i + 0.5) / sides) * 2 * Math.PI;

        return [x + Math.cos(angle) * r, y + Math.sin(angle) * r, z];
      });

    const points = rings.map(ring);

    for (let i = 0; i < rings.length - 1; i++) {
      const [z0, , y0] = rings[i];
      const [z1, , y1] = rings[i + 1];
      const inside: Vec = [x, (y0 + y1) / 2, (z0 + z1) / 2];

      for (let j = 0; j < sides; j++) {
        const k = (j + 1) % sides;
        const [a, b] = [points[i][j], points[i][k]];
        const [c, d] = [points[i + 1][j], points[i + 1][k]];
        this.triangle(inside, tail, a, b, c);
        this.triangle(inside, tail, b, d, c);
      }
    }

    for (const end of [0, rings.length - 1]) {
      const [z, , y] = rings[end];
      const centre: Vec = [x, y, z];
      const inside: Vec = [x, y, z + (end === 0 ? 1 : -1)];

      for (let j = 0; j < sides; j++) {
        const next = points[end][(j + 1) % sides];
        this.triangle(inside, tail, centre, points[end][j], next);
      }
    }
  }

  /**
   * A flat convex panel: `outline` (in order round its edge) and a copy
   * moved by `thickness`, joined round the sides.
   */
  slab(outline: Vec[], thickness: Vec, tail = 0) {
    const other = outline.map((p): Vec => [
      p[0] + thickness[0],
      p[1] + thickness[1],
      p[2] + thickness[2],
    ]);

    const all = [...outline, ...other];

    const mean = (k: number) =>
      all.reduce((sum, p) => sum + p[k], 0) / all.length;

    const inside: Vec = [mean(0), mean(1), mean(2)];

    for (let i = 1; i < outline.length - 1; i++) {
      this.triangle(inside, tail, outline[0], outline[i], outline[i + 1]);
      this.triangle(inside, tail, other[0], other[i], other[i + 1]);
    }

    outline.forEach((a, i) => {
      const j = (i + 1) % outline.length;
      this.triangle(inside, tail, a, outline[j], other[i]);
      this.triangle(inside, tail, outline[j], other[j], other[i]);
    });
  }

  /** A pair of wings or tailplanes: root and tip chords, [front, back]. */
  wings(
    y: number,
    root: [number, number],
    span: number,
    tip: [number, number],
    thickness: number,
    tail = 0
  ) {
    for (const side of [-1, 1]) {
      this.slab(
        [
          [0, y, root[0]],
          [side * span, y, tip[0]],
          [side * span, y, tip[1]],
          [0, y, root[1]],
        ],
        [0, thickness, 0],
        tail
      );
    }
  }

  /** A vertical fin from the fuselage top: root and top chords. */
  fin(
    y: number,
    root: [number, number],
    height: number,
    top: [number, number],
    thickness: number
  ) {
    const x = -thickness / 2;
    this.slab(
      [
        [x, y, root[0]],
        [x, y + height, top[0]],
        [x, y + height, top[1]],
        [x, y, root[1]],
      ],
      [thickness, 0, 0],
      1
    );
  }

  build() {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(this.position), 3)
    );
    geometry.setAttribute(
      "tail",
      new BufferAttribute(new Float32Array(this.tail), 1)
    );
    geometry.computeVertexNormals();

    return geometry;
  }
}

/** Twin-engined airliner: low swept wing, engines under it. */
export function createJetGeometry() {
  const b = new Builder();
  b.tube([
    [-0.5, 0.004, -0.012],
    [-0.47, 0.03, -0.004],
    [-0.42, 0.05, 0],
    [0.24, 0.053, 0],
    [0.42, 0.03, 0.018],
    [0.5, 0.008, 0.03],
  ]);
  b.wings(-0.035, [-0.1, 0.12], 0.475, [0.13, 0.2], 0.012);

  for (const x of [-0.17, 0.17]) {
    b.tube(
      [
        [-0.13, 0.026, -0.07],
        [-0.02, 0.026, -0.07],
        [0.02, 0.016, -0.065],
      ],
      x
    );
  }

  b.wings(0.012, [0.36, 0.48], 0.17, [0.45, 0.5], 0.008);
  b.fin(0.03, [0.28, 0.48], 0.17, [0.43, 0.5], 0.012);

  return b.build();
}

/** Turboprop or light aircraft: high straight wing, T-tail. */
export function createPropGeometry() {
  const b = new Builder();
  b.tube([
    [-0.5, 0.008, -0.004],
    [-0.46, 0.035, 0],
    [-0.38, 0.05, 0],
    [0.2, 0.05, 0],
    [0.42, 0.022, 0.03],
    [0.5, 0.008, 0.04],
  ]);
  b.wings(0.045, [-0.13, 0.0], 0.55, [-0.1, -0.03], 0.014);

  for (const x of [-0.17, 0.17]) {
    b.tube(
      [
        [-0.25, 0.012, 0.025],
        [-0.22, 0.026, 0.03],
        [0.0, 0.022, 0.035],
      ],
      x
    );
  }

  b.fin(0.035, [0.28, 0.48], 0.19, [0.41, 0.5], 0.012);
  b.wings(0.22, [0.41, 0.5], 0.18, [0.45, 0.5], 0.008, 1);

  return b.build();
}

/** Helicopter: cabin pod, tail boom and fin, and a stopped rotor's blades. */
export function createHelicopterGeometry() {
  const b = new Builder();
  b.tube([
    [-0.45, 0.02, -0.02],
    [-0.4, 0.09, 0],
    [-0.3, 0.12, 0.01],
    [0.0, 0.11, 0.02],
    [0.1, 0.04, 0.05],
    [0.46, 0.018, 0.06],
    [0.5, 0.01, 0.065],
  ]);
  b.fin(0.04, [0.4, 0.5], 0.12, [0.45, 0.5], 0.012);

  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    const half = 0.45;
    const width = 0.015;

    const blade = (u: number, v: number): Vec => [
      c * u - s * v,
      0.15,
      s * u + c * v - 0.15,
    ];

    b.slab(
      [
        blade(-half, -width),
        blade(half, -width),
        blade(half, width),
        blade(-half, width),
      ],
      [0, 0.006, 0]
    );
  }

  return b.build();
}
