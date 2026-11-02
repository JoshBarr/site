import {
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Vector2,
} from "three/webgpu";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { TurbineModel } from "./turbineModels";

/** Towers run this far below their base so uneven ground can't show a gap. */
const FOOTING = 12;

export function towerTop(model: TurbineModel) {
  return model.hubHeight - model.hubAbove;
}

/** Top of the nacelle above the yaw bearing, where the warning light sits. */
export function nacelleTop(model: TurbineModel) {
  return model.nacelle === "box" ? model.hubAbove + 2 : model.hubAbove + 2.2;
}

/** Tapered tube from below ground to the yaw bearing. */
export function createTowerGeometry(model: TurbineModel) {
  const height = towerTop(model);

  // Keep the taper going below ground.
  const below =
    model.towerBaseRadius +
    ((model.towerBaseRadius - model.towerTopRadius) * FOOTING) / height;

  const geometry = new CylinderGeometry(
    model.towerTopRadius,
    below,
    height + FOOTING,
    32,
    1,
    true
  );

  geometry.translate(0, (height - FOOTING) / 2, 0);

  return geometry;
}

/** Surface of revolution about +z from [radius, z] pairs, z increasing. */
function revolve(profile: [number, number][], segments = 32) {
  const geometry = new LatheGeometry(
    profile.map(([r, z]) => new Vector2(r, z)),
    segments
  );

  // Lathe turns about +y; lay it along +z.
  return geometry.rotateX(Math.PI / 2);
}

/**
 * Nacelle and spinner in the nacelle frame (origin on the yaw bearing). The
 * spinner is round, so it can sit still here while the blades turn.
 */
export function createNacelleGeometry(model: TurbineModel) {
  const { hubAbove, overhang, tilt } = model;

  let body: BufferGeometry;
  let spinner: BufferGeometry;

  if (model.nacelle === "box") {
    // Siemens: long rounded box, rotor out ahead of the tower.
    body = new RoundedBoxGeometry(3.6, 3.9, 10, 2, 0.5);
    body.translate(0, hubAbove, -1.7);
    spinner = revolve([
      [1.75, -1.2],
      [1.85, -0.3],
      [1.75, 0.6],
      [1.45, 1.4],
      [1.0, 2.0],
      [0.45, 2.4],
      [0, 2.55],
    ]);
  } else {
    // Enercon: the "egg", widest around the ring generator up front.
    body = revolve([
      [0, -3.6],
      [0.9, -3.3],
      [1.55, -2.6],
      [1.95, -1.6],
      [2.15, -0.4],
      [2.15, 0.8],
      [2.0, 1.8],
      [1.8, 2.6],
      [1.6, 2.8],
    ]);
    body.translate(0, hubAbove, 0);
    spinner = revolve([
      [1.65, -0.7],
      [1.7, 0],
      [1.5, 0.8],
      [1.05, 1.4],
      [0.5, 1.8],
      [0, 1.95],
    ]);
  }

  // Same placement the blades get in the shader.
  spinner.translate(0, 0, overhang).rotateX(-tilt).translate(0, hubAbove, 0);

  // Lathe and box carry different attributes; positions and normals suffice.
  const parts = [body, spinner].map((part) => {
    const g = part.index ? part.toNonIndexed() : part;

    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    }

    return g;
  });

  return mergeGeometries(parts);
}

/** NACA four-digit half-thickness at x (0 leading edge, 1 trailing). */
function halfThickness(x: number, ratio: number) {
  return (
    5 *
    ratio *
    (0.2969 * Math.sqrt(x) -
      0.126 * x -
      0.3516 * x ** 2 +
      0.2843 * x ** 3 -
      0.1036 * x ** 4)
  );
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);

  return t * t * (3 - 2 * t);
};

/**
 * One blade in its own frame: span along +y from the axis, chord along x
 * with the leading edge toward +x, the pitch axis at 30% chord. The rotor
 * turns clockwise seen from upwind (+z), so the leading edge leads.
 */
export function createBladeGeometry(model: TurbineModel, around = 20) {
  const { rotorRadius: R, rootRadius, maxChord, maxChordAt: xm } = model;
  const x0 = rootRadius / R;
  const rootDiameter = 0.55 * maxChord;
  const rootEnd = x0 + 0.03;

  // Stations along the span, as fractions of the radius.
  const stations = [x0, rootEnd, x0 + (xm - x0) * 0.6, xm];

  for (const x of [0.28, 0.38, 0.5, 0.62, 0.74, 0.84, 0.92, 0.97, 1]) {
    if (x > xm + 0.02) stations.push(x);
  }

  const positions: number[] = [];

  for (const x of stations) {
    // Round root flaring into the widest chord, then tapering roughly as 1/r.
    const out = smoothstep(rootEnd, xm, x);
    const tipRound = x > 0.97 ? 0.45 : 1;

    const chord =
      (x <= xm
        ? rootDiameter + (maxChord - rootDiameter) * out
        : maxChord * (xm / x) ** 0.85) * tipRound;

    const ratio = 0.4 - 0.22 * smoothstep(xm, 0.7, x);
    const round = 1 - out;

    const twist =
      ((12 * Math.PI) / 180) * Math.max((1 - x) / (1 - xm), 0) ** 1.6;

    for (let j = 0; j < around; j++) {
      const a = (2 * Math.PI * j) / around;
      const along = (1 - Math.cos(a)) / 2;
      const side = a < Math.PI ? 1 : -1;
      const foilX = (0.3 - along) * chord;
      const foilZ = side * halfThickness(along, ratio) * chord;
      const circleX = 0.5 * chord * Math.cos(a);
      const circleZ = 0.5 * chord * Math.sin(a);
      const px = foilX + (circleX - foilX) * round;
      const pz = foilZ + (circleZ - foilZ) * round;
      // Twist turns the leading edge toward the wind (+z) near the root.
      positions.push(
        px * Math.cos(twist) - pz * Math.sin(twist),
        x * R,
        px * Math.sin(twist) + pz * Math.cos(twist)
      );
    }
  }

  // Tip point closes the last section.
  const tip = positions.length / 3;
  positions.push(0, R + 0.05, 0);

  const indices: number[] = [];

  const at = (k: number, j: number) =>
    k === stations.length ? tip : k * around + (j % around);

  for (let k = 0; k < stations.length; k++) {
    for (let j = 0; j < around; j++) {
      if (k === stations.length - 1) {
        indices.push(at(k, j), tip, at(k, j + 1));
      } else {
        indices.push(at(k, j), at(k + 1, j), at(k, j + 1));
        indices.push(at(k, j + 1), at(k + 1, j), at(k + 1, j + 1));
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

/** Mean chord over the outer blade, for keeping blades a pixel wide. */
export function typicalChord(model: TurbineModel) {
  return model.maxChord * 0.5;
}
