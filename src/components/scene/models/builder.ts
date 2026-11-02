import { BufferAttribute, BufferGeometry, Color } from "three/webgpu";

// Flat-shaded models built up from simple solids, painted as they go: each
// triangle carries its colour and, for windows and signs, what it glows at
// night. Triangles are wound to face away from a point inside their solid,
// so solids can be put together in any order.

export type Vec = [number, number, number];

/** Lit windows at night, warm: as the trains' and buses'. */
export const WINDOW_GLOW = 0xd9c9ad;

const centroid = (points: Vec[]): Vec => {
  const sum: Vec = [0, 0, 0];

  for (const p of points) {
    sum[0] += p[0];
    sum[1] += p[1];
    sum[2] += p[2];
  }

  return [
    sum[0] / points.length,
    sum[1] / points.length,
    sum[2] / points.length,
  ];
};

export class ModelBuilder {
  private position: number[] = [];
  private colors: number[] = [];
  private glows: number[] = [];
  private paint = new Color(1, 1, 1);
  private glow = new Color(0, 0, 0);

  /** Sides of tubes and cylinders. */
  sides = 8;

  /** Paints what's built next `hex`, glowing `glow` (times the lights). */
  use(hex: number, glow = 0) {
    this.paint.setHex(hex);
    this.glow.setHex(glow);

    return this;
  }

  /** A triangle, wound to face away from `inside`. */
  triangle(inside: Vec, a: Vec, b: Vec, c: Vec) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];

    const normal = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];

    const out = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3 - inside[k]);
    const facing = normal[0] * out[0] + normal[1] * out[1] + normal[2] * out[2];

    for (const p of facing < 0 ? [a, c, b] : [a, b, c]) {
      this.position.push(...p);
      this.colors.push(this.paint.r, this.paint.g, this.paint.b);
      this.glows.push(this.glow.r, this.glow.g, this.glow.b);
    }
  }

  quad(inside: Vec, a: Vec, b: Vec, c: Vec, d: Vec) {
    this.triangle(inside, a, b, c);
    this.triangle(inside, a, c, d);
  }

  /** A convex polygon, as a fan, facing away from `inside`. */
  polygon(inside: Vec, points: Vec[]) {
    for (let i = 1; i < points.length - 1; i++) {
      this.triangle(inside, points[0], points[i], points[i + 1]);
    }
  }

  /**
   * Outlines joined one to the next, each with as many points, in the same
   * order round. Each outline closes back on itself unless `ring` is false,
   * and the ends are capped unless `caps` is.
   */
  loft(sections: Vec[][], { caps = true, ring = true } = {}) {
    const centres = sections.map(centroid);

    for (let s = 0; s < sections.length - 1; s++) {
      const [a, b] = [sections[s], sections[s + 1]];
      const inside = centroid([centres[s], centres[s + 1]]);

      for (let i = 0; i < (ring ? a.length : a.length - 1); i++) {
        const j = (i + 1) % a.length;
        this.quad(inside, a[i], a[j], b[j], b[i]);
      }
    }

    if (!caps) return;
    const last = sections.length - 1;
    this.cap(sections[0], centres[0], centres[Math.min(1, last)]);
    this.cap(sections[last], centres[last], centres[Math.max(last - 1, 0)]);
  }

  private cap(outline: Vec[], centre: Vec, beyond: Vec) {
    // Inside is toward the next section; a lone section has no inside.
    const inside: Vec =
      beyond === centre ? [centre[0], centre[1] - 1, centre[2]] : beyond;

    outline.forEach((p, i) => {
      this.triangle(inside, centre, p, outline[(i + 1) % outline.length]);
    });
  }

  /** A box between two corners. */
  box(min: Vec, max: Vec) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;

    this.loft([
      [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
      ],
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
    ]);
  }

  /** An outline across z (x, y; convex) run from z0 to z1. */
  prism(outline: [number, number][], z0: number, z1: number) {
    this.loft([z0, z1].map((z) => outline.map(([x, y]): Vec => [x, y, z])));
  }

  /**
   * A tube along z through rings of [z, radius, y], or [z, half width, y,
   * half height] for ovals, closed at both ends.
   */
  tube(rings: number[][], x = 0) {
    this.loft(
      rings.map(([z, r, y, h = r]) =>
        Array.from({ length: this.sides }, (_, i): Vec => {
          const angle = ((i + 0.5) / this.sides) * 2 * Math.PI;

          return [x + Math.cos(angle) * r, y + Math.sin(angle) * h, z];
        })
      )
    );
  }

  /** A round bar from `a` to `b`. */
  cylinder(a: Vec, b: Vec, radius: number) {
    const axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    const w = axis.map((k) => k / length);
    // Any two directions square to the axis and each other.
    const helper = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];

    const cross = (p: number[], q: number[]) => [
      p[1] * q[2] - p[2] * q[1],
      p[2] * q[0] - p[0] * q[2],
      p[0] * q[1] - p[1] * q[0],
    ];

    const u = cross(w, helper);
    const ul = Math.hypot(u[0], u[1], u[2]);
    const n = u.map((k) => k / ul);
    const m = cross(w, n);

    this.loft(
      [a, b].map((end) =>
        Array.from({ length: this.sides }, (_, i): Vec => {
          const angle = ((i + 0.5) / this.sides) * 2 * Math.PI;
          const [c, s] = [Math.cos(angle) * radius, Math.sin(angle) * radius];

          return [
            end[0] + n[0] * c + m[0] * s,
            end[1] + n[1] * c + m[1] * s,
            end[2] + n[2] * c + m[2] * s,
          ];
        })
      )
    );
  }

  /**
   * A flat convex panel: `outline` (in order round its edge) and a copy
   * moved by `thickness`, joined round the sides.
   */
  slab(outline: Vec[], thickness: Vec) {
    const other = outline.map((p): Vec => [
      p[0] + thickness[0],
      p[1] + thickness[1],
      p[2] + thickness[2],
    ]);

    this.loft([outline, other]);
  }

  build() {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(this.position), 3)
    );
    geometry.setAttribute(
      "color",
      new BufferAttribute(new Float32Array(this.colors), 3)
    );
    geometry.setAttribute(
      "glow",
      new BufferAttribute(new Float32Array(this.glows), 3)
    );
    geometry.computeVertexNormals();

    return geometry;
  }
}
