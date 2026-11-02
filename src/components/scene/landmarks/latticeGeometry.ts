import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  float,
  floor,
  fract,
  fwidth,
  interleavedGradientNoise,
  max,
  min,
  mix,
  mod,
  modelWorldMatrix,
  positionGeometry,
  screenCoordinate,
  smoothstep,
  sqrt,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { pixelAngle } from "./common";

// Square, four-legged steel lattice towers.
//
// The steelwork isn't modelled member by member: each face is one tapered
// panel, and its fragment shader draws the legs, horizontals and X-bracing
// with analytic antialiasing. Up close they're crisp; far off, members
// thinner than a pixel become partial coverage (alpha to coverage) instead
// of shimmering, the way a lattice tower greys into the haze.

interface LatticeSection {
  /** Height of this section's top above the base, m. */
  top: number;
  /** Face width at that height, m. */
  width: number;
}

export interface LatticeTowerSpec {
  name: string;
  /** Face width at the base, m. */
  baseWidth: number;
  sections: LatticeSection[];
  /** Width of the corner legs and the bracing, m. */
  leg: number;
  brace: number;
  colour: string;
  /** Painted bands (e.g. aviation red and white) from the top down, if any. */
  bands?: { colour: string; height: number; count: number };
  /** Gratings around the tower at these heights, m. */
  platforms: number[];
  /** Panel antennas on every face between two heights. */
  antennas: { from: number; to: number; perFace: number; depth: number }[];
  /** Microwave dishes: drum radomes facing a compass bearing. */
  dishes: { height: number; diameter: number; bearing: number }[];
  /** Obstruction lights at these heights. */
  lights: number[];
}

/**
 * Kordia's Mt Kaukau tower (1965, Furukawa): four legs, lattice steel,
 * 122 m until 2022, when the top 18 m went; about 100 m now. FM panels
 * around 65 m, UHF TV at 93 m, a steady red light on top.
 *
 * The widths and the colour are estimates; check them against photos.
 */
export const KAUKAU_TOWER: LatticeTowerSpec = {
  name: "Mt Kaukau",
  baseWidth: 12,
  sections: [
    { top: 30, width: 7.5 },
    { top: 58, width: 4.2 },
    { top: 74, width: 2.8 },
    { top: 100, width: 2.4 },
  ],
  leg: 0.6,
  brace: 0.22,
  colour: "#a4a9ab",
  platforms: [58, 74, 87, 100],
  antennas: [
    { from: 60, to: 71, perFace: 2, depth: 0.5 },
    { from: 88, to: 99.5, perFace: 2, depth: 0.45 },
  ],
  dishes: [
    { height: 44, diameter: 3, bearing: 150 },
    { height: 44, diameter: 3, bearing: 30 },
    { height: 50, diameter: 2.4, bearing: 205 },
    { height: 50, diameter: 1.8, bearing: 335 },
  ],
  lights: [100.6],
};

/**
 * The communications tower by the Mt Victoria lookout: a four-legged
 * lattice tower carrying cellular panels and microwave links.
 *
 * Its height and dressing are guesses (no published figures); check them
 * against photos.
 */
export const MT_VICTORIA_TOWER: LatticeTowerSpec = {
  name: "Mt Victoria",
  baseWidth: 5,
  sections: [
    { top: 20, width: 2.6 },
    { top: 40, width: 1.6 },
  ],
  leg: 0.22,
  brace: 0.1,
  colour: "#a4a9ab",
  platforms: [30, 40],
  antennas: [{ from: 35, to: 39.5, perFace: 2, depth: 0.25 }],
  dishes: [
    { height: 26, diameter: 1.2, bearing: 290 },
    { height: 28, diameter: 0.9, bearing: 330 },
    { height: 32, diameter: 1.2, bearing: 200 },
  ],
  lights: [40.5],
};

export function towerHeight(spec: LatticeTowerSpec) {
  return spec.sections[spec.sections.length - 1].top;
}

/** Face width at a height. */
export function widthAt(spec: LatticeTowerSpec, height: number) {
  let below = { top: 0, width: spec.baseWidth };

  for (const section of spec.sections) {
    if (height <= section.top) {
      const t = (height - below.top) / (section.top - below.top);

      return below.width + (section.width - below.width) * t;
    }

    below = section;
  }

  return below.width;
}

/** How far below the base the legs run, so slopes can't show a gap. */
const FOOTING = 6;

/**
 * Four tapered faces per section. Per vertex: `lattice` (across the face
 * from its centre, up from the section's foot) and `frame` (half-widths at
 * foot and top, section height, panel count).
 */
function createFaces(spec: LatticeTowerSpec) {
  const positions: number[] = [];
  const normals: number[] = [];
  const lattice: number[] = [];
  const frame: number[] = [];
  const indices: number[] = [];

  let foot = { top: -FOOTING, width: widthAt(spec, -FOOTING) };
  const sections = [{ top: 0, width: spec.baseWidth }, ...spec.sections];

  for (const section of sections) {
    const h = section.top - foot.top;
    const w0 = foot.width / 2;
    const w1 = section.width / 2;
    // Panels about as tall as the face is wide.
    const panels = Math.max(1, Math.round(h / ((w0 + w1) * 0.9)));
    const lean = (w0 - w1) / h;

    // Each face as (outward axis, across axis) on x/z.
    for (const [nx, nz] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ]) {
      const ax = nz;
      const az = -nx;
      const base = positions.length / 3;

      const corners: [number, number, number][] = [
        [-1, 0, w0],
        [1, 0, w0],
        [1, h, w1],
        [-1, h, w1],
      ];

      const normalLength = Math.hypot(1, lean);

      for (const [side, y, w] of corners) {
        positions.push(
          nx * w + ax * side * w,
          foot.top + y,
          nz * w + az * side * w
        );
        normals.push(nx / normalLength, lean / normalLength, nz / normalLength);
        lattice.push(side * w, y);
        frame.push(w0, w1, h, panels);
      }

      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    foot = section;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("lattice", new Float32BufferAttribute(lattice, 2));
  geometry.setAttribute("frame", new Float32BufferAttribute(frame, 4));
  geometry.setIndex(indices);

  return geometry;
}

/** Coverage of a line `width` wide at distance `d`, `pixel` metres a pixel. */
function line(d, width: number, pixel) {
  const half = float(width).mul(0.5);
  // Thinner than a pixel: drawn a pixel wide, but proportionally fainter.
  const drawn = max(half, pixel.mul(0.5));

  return clamp(drawn.sub(d).div(pixel).add(0.5), 0, 1).mul(half.div(drawn));
}

/** Faces are kept at least this many pixels wide, fading to compensate. */
const MIN_PIXELS = 1.2;

/**
 * Ladders, feeder cables and mounts add to the steelwork, so a distant tower
 * reads more solid than its members alone.
 */
const CLUTTER = 1.8;

function createLatticeMaterial(spec: LatticeTowerSpec, msaa: boolean) {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.7,
    metalness: 0,
    side: DoubleSide,
  });

  const lattice = attribute("lattice", "vec2");
  const frame = attribute("frame", "vec4");
  const s = lattice.x;
  const y = lattice.y;
  const halfWidth = mix(frame.x, frame.y, y.div(frame.z));

  // Far off, widen the faces to stay a pixel wide (they'd drop out between
  // samples) and spread their coverage thinner to match.
  const world = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const metresPerPixel = cameraPosition.distance(world).mul(pixelAngle);

  const widen = max(
    float(1),
    metresPerPixel.mul(MIN_PIXELS).div(halfWidth.mul(2))
  );

  material.positionNode = positionGeometry.mul(vec3(widen, 1, widen));
  // The shadow pass sees the tower from the sun: true size.
  material.castShadowPositionNode = positionGeometry;

  // Metres per pixel across the face (up it, really: widening stretches s).
  const pixel = max(max(fwidth(s), fwidth(y)), 1e-4);

  const legs = line(
    abs(halfWidth.sub(abs(s)).sub(spec.leg / 2)),
    spec.leg,
    pixel
  );

  const panelHeight = frame.z.div(frame.w);
  const f = fract(y.div(panelHeight));

  const horizontals = line(
    min(f, float(1).sub(f)).mul(panelHeight),
    spec.brace,
    pixel
  );

  // X-bracing corner to corner across each panel.
  const u = s.div(halfWidth);
  const across = f.mul(2).sub(1);

  const diagonalLength = sqrt(
    panelHeight.mul(panelHeight).add(halfWidth.mul(halfWidth).mul(4))
  );

  const slant = panelHeight.div(diagonalLength);
  const diagonal = (d) => line(d.mul(halfWidth).mul(slant), spec.brace, pixel);

  const bracing = max(
    diagonal(abs(u.sub(across))),
    diagonal(abs(u.add(across)))
  );

  const pattern = max(max(legs, horizontals), bracing);

  // Once panels are a few pixels tall the pattern can't be resolved: use the
  // fraction of each panel that's steel instead.
  const solidity = min(
    float(spec.leg)
      .div(halfWidth)
      .add(float(spec.brace).div(panelHeight))
      .add(
        float(spec.brace).mul(diagonalLength).div(halfWidth.mul(panelHeight))
      )
      .mul(CLUTTER),
    1
  );

  const unresolved = smoothstep(0.12, 0.5, pixel.div(panelHeight));
  const steel = mix(pattern, solidity, unresolved);
  const coverage = steel.div(widen);

  if (spec.bands) {
    const { colour, height, count } = spec.bands;
    const fromTop = float(towerHeight(spec)).sub(positionGeometry.y);
    const band = floor(fromTop.div(height));
    const painted = mod(band, 2).equal(0).and(band.lessThan(count));
    material.colorNode = mix(
      uniform(new Color(spec.colour)),
      uniform(new Color(colour)),
      painted.select(float(1), float(0))
    );
  } else {
    material.color = new Color(spec.colour);
  }

  const noise = interleavedGradientNoise(screenCoordinate.xy);
  // In the shadow map, keep each texel's share of steel; filtering averages
  // that back into a partial shadow.
  material.maskShadowNode = steel.greaterThan(noise);

  if (msaa) {
    // A few samples a pixel quantise coverage; dither across the steps so
    // faint coverage doesn't round away to nothing.
    material.alphaToCoverage = true;
    material.opacityNode = clamp(coverage.add(noise.sub(0.5).mul(0.25)), 0, 1);
  } else {
    // No multisampling: dither the partial coverage instead.
    material.opacityNode = coverage;
    material.alphaTestNode = noise.mul(0.98).add(0.01);
  }

  return material;
}

/** Bearing (degrees from north) to a rotation about +y for something facing +z. */
const headingFor = (bearing: number) => Math.PI - (bearing * Math.PI) / 180;

/** Platforms, panel antennas and dishes: plain solid shapes. */
function createFittings(spec: LatticeTowerSpec) {
  const parts: BufferGeometry[] = [];

  for (const height of spec.platforms) {
    const width = widthAt(spec, height) + 1.6;
    parts.push(new BoxGeometry(width, 0.3, width).translate(0, height, 0));
  }

  for (const { from, to, perFace, depth } of spec.antennas) {
    const width = widthAt(spec, (from + to) / 2);
    const panel = (width / perFace) * 0.8;

    for (const [nx, nz] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ]) {
      for (let k = 0; k < perFace; k++) {
        const offset = ((k + 0.5) / perFace - 0.5) * width;
        const out = width / 2 + depth / 2 + 0.3;

        const box = new BoxGeometry(
          nx === 0 ? panel : depth,
          to - from,
          nx === 0 ? depth : panel
        );

        box.translate(
          nx * out + nz * offset,
          (from + to) / 2,
          nz * out + nx * offset
        );
        parts.push(box);
      }
    }
  }

  for (const { height, diameter, bearing } of spec.dishes) {
    const radius = diameter / 2;
    const drum = new CylinderGeometry(radius, radius, diameter * 0.35, 24);
    const reach = widthAt(spec, height) / 2 + diameter * 0.3;
    drum
      .rotateX(Math.PI / 2)
      .translate(0, height, reach)
      .rotateY(headingFor(bearing));
    parts.push(drum);
  }

  // Lathe/box/cylinder attribute sets differ: keep what lighting needs.
  return mergeGeometries(
    parts.map((part) => {
      const g = part.index ? part.toNonIndexed() : part;
      g.deleteAttribute("uv");

      return g;
    })
  );
}

/**
 * The tower as meshes in its own frame (base at the origin, y up). `msaa`:
 * whether the canvas multisamples, for the lattice's partial coverage.
 */
export function createLatticeTower(spec: LatticeTowerSpec, msaa: boolean) {
  const faces = new Mesh(createFaces(spec), createLatticeMaterial(spec, msaa));

  const fittings = new Mesh(
    createFittings(spec),
    new MeshStandardNodeMaterial({
      color: "#c9cccc",
      roughness: 0.6,
      metalness: 0,
    })
  );

  return {
    meshes: [faces, fittings],
    dispose() {
      for (const mesh of [faces, fittings]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    },
  };
}
