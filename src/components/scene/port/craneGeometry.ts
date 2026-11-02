import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  Vector3,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Ship-to-shore container cranes, as box-section members. In the crane's
// frame x runs seaward across the wharf, z along the rail, y up; the origin
// is on the ground midway between the rails.
//
// Each member carries `spread` (from its own axis to the vertex) and
// `thickness`, so the shader can fatten thin members far off instead of
// letting them break up into dashes.

export interface CraneSpec {
  /** Seaside rail to landside rail, m. */
  gauge: number;
  /** Between the legs along the rail, m; the girders sit on them. */
  legSpacing: number;
  /** Top of the lower portal beams, m. */
  portalHeight: number;
  /** Trolley girder and boom hinge, m. */
  girderHeight: number;
  /** Boom reach past the seaside rail, and girder behind the landside, m. */
  outreach: number;
  backreach: number;
  /** Top of the A-frame, m. */
  apexHeight: number;
  colour: string;
}

/**
 * CentrePort's two cranes at Thorndon Container Wharf. Sized as a typical
 * Panamax ship-to-shore crane, not from drawings: check against photos.
 */
export const CENTREPORT_CRANE: CraneSpec = {
  gauge: 30.5,
  legSpacing: 17,
  portalHeight: 14,
  girderHeight: 42,
  outreach: 45,
  backreach: 16,
  apexHeight: 70,
  colour: "#d4d6d4",
};

export interface CranePose {
  /** Boom above horizontal, radians: 0 working, about 80° stowed. */
  boom: number;
  /** Trolley along the girder from the crane's centre, m (seaward +). */
  trolley: number;
}

/** Legs run this far below the rails so uneven ground can't show a gap. */
const FOOTING = 2;

const tmp = new Vector3();

/**
 * A box `width` × `depth` in section from a to b. Depth is in the vertical
 * plane through the member (or along x, for vertical members).
 */
function member(a: Vector3, b: Vector3, width: number, depth = width) {
  const dir = new Vector3().subVectors(b, a);
  const length = dir.length();
  dir.normalize();
  const ref =
    Math.abs(dir.y) > 0.99 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const side = new Vector3().crossVectors(dir, ref).normalize();
  const up = new Vector3().crossVectors(side, dir);
  const basis = new Matrix4().makeBasis(dir, up, side);

  const box = new BoxGeometry(length, depth, width);
  box.deleteAttribute("uv");
  const position = box.getAttribute("position");
  const spread = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    tmp.set(0, position.getY(i), position.getZ(i)).applyMatrix4(basis);
    tmp.toArray(spread, i * 3);
  }
  box.setAttribute("spread", new Float32BufferAttribute(spread, 3));
  box.setAttribute(
    "thickness",
    new Float32BufferAttribute(
      new Float32Array(position.count).fill(Math.min(width, depth)),
      1
    )
  );
  box.translate(length / 2, 0, 0);
  box.applyMatrix4(basis.setPosition(a));
  return box;
}

/** A solid block (machinery house, trolley), never fattened. */
function block(centre: Vector3, size: [number, number, number]) {
  const box = new BoxGeometry(...size);
  box.deleteAttribute("uv");
  const count = box.getAttribute("position").count;
  box.setAttribute(
    "spread",
    new Float32BufferAttribute(new Float32Array(count * 3), 3)
  );
  box.setAttribute(
    "thickness",
    new Float32BufferAttribute(new Float32Array(count).fill(1e3), 1)
  );
  return box.translate(centre.x, centre.y, centre.z);
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

/** Where the A-frame's top sits, in the crane's frame. */
function apexX(spec: CraneSpec) {
  return spec.gauge / 2 - 5;
}

/** Tip of the boom, at the centre line. */
function boomTip(spec: CraneSpec, pose: CranePose) {
  const length = spec.outreach + 2;
  return v(
    spec.gauge / 2 + Math.cos(pose.boom) * length,
    spec.girderHeight + Math.sin(pose.boom) * length,
    0
  );
}

export function createCraneGeometry(spec: CraneSpec, pose: CranePose) {
  const g = spec.gauge / 2;
  const s = spec.legSpacing / 2;
  const h = spec.girderHeight;
  const back = -g - spec.backreach;
  const ax = apexX(spec);
  const tip = boomTip(spec, pose);
  const parts: BufferGeometry[] = [];

  for (const z of [-s, s]) {
    // Portal: legs, the low beam the straddle carriers pass under, and the
    // girder across the top, running on into the back reach.
    for (const x of [-g, g]) {
      parts.push(member(v(x, -FOOTING, z), v(x, h, z), 1.8));
    }
    parts.push(
      member(v(-g, spec.portalHeight, z), v(g, spec.portalHeight, z), 1.4, 2)
    );
    parts.push(member(v(back, h, z), v(g, h, z), 1.8, 3.2));

    // Boom, hinged at the seaside leg.
    parts.push(member(v(g, h, z), v(tip.x, tip.y, z), 1.6, 2.8));

    // A-frame, tied back to the end of the girder and forward to the boom.
    parts.push(member(v(g, h, z), v(ax, spec.apexHeight, z), 1.4));
    parts.push(member(v(-g, h, z), v(ax, spec.apexHeight, z), 1.4));
    parts.push(member(v(ax, spec.apexHeight, z), v(back, h + 1.6, z), 0.6));
    const middle = v(g, h, z).lerp(v(tip.x, tip.y, z), 0.55);
    parts.push(member(v(ax, spec.apexHeight, z), middle, 0.5));
    parts.push(member(v(ax, spec.apexHeight, z), v(tip.x, tip.y, z), 0.5));
  }

  // Across the rail: bogies and sill beams at the feet, ties at the top.
  for (const x of [-g, g]) {
    parts.push(member(v(x, 1.2, -s - 4), v(x, 1.2, s + 4), 2, 2.4));
    parts.push(member(v(x, h, -s), v(x, h, s), 1.6, 2));
    parts.push(
      member(v(x, spec.portalHeight, -s), v(x, spec.portalHeight, s), 1.2)
    );
  }
  parts.push(member(v(back, h, -s), v(back, h, s), 1.6, 2));
  parts.push(
    member(v(ax, spec.apexHeight, -s), v(ax, spec.apexHeight, s), 1.4)
  );
  parts.push(member(v(tip.x, tip.y, -s), v(tip.x, tip.y, s), 1.4));

  // Machinery house on the back reach, trolley and cab under the girders.
  parts.push(block(v(back + 8, h + 4.2, 0), [14, 5, spec.legSpacing + 2.5]));
  // A stowed boom takes the trolley's rails with it: park it inboard.
  const trolley =
    pose.boom > 0.1 ? Math.min(pose.trolley, g - 4) : pose.trolley;
  parts.push(block(v(trolley, h - 1.4, 0), [7, 2.4, spec.legSpacing - 2]));
  parts.push(block(v(trolley + 2, h - 4.4, 0), [3, 3, 3]));

  return mergeGeometries(parts);
}

/** Obstruction lights, crane frame: both ends of the A-frame and the boom tip. */
export function craneLightPoints(spec: CraneSpec, pose: CranePose) {
  const s = spec.legSpacing / 2;
  const ax = apexX(spec);
  const tip = boomTip(spec, pose);
  return [
    v(ax, spec.apexHeight + 1, -s),
    v(ax, spec.apexHeight + 1, s),
    v(tip.x, tip.y + 1.2, 0),
  ];
}

/** Highest point of the crane above its rails, m. */
export function craneHeight(spec: CraneSpec, pose: CranePose) {
  return Math.max(spec.apexHeight, boomTip(spec, pose).y) + 1;
}
