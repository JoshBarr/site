import {
  BackSide,
  CustomBlending,
  CylinderGeometry,
  GreaterDepth,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  OneFactor,
  SrcColorFactor,
  Vector3,
  ZeroFactor,
} from "three/webgpu";
import {
  float,
  max,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";

// Seeing what's followed through a tunnel: the ground around it is cut
// away, as far as anything drawn after it knows.
//
// Nothing's taken out of the ground itself. A drum around the vehicle,
// standing on a floor just under the tunnel's, is drawn once everything
// else solid has been, and only where something's in front of its far
// side. There it darkens the picture of the hill (and the trees and houses
// on it) already drawn, and has the depth buffer forget them for its own
// floor and far wall. What's drawn after that passes the depth test where
// the hill was: the vehicles, in full, and then the tunnel's lining,
// blended over the darkened ground, which shows through as if it had gone
// part clear.

/** After everything else solid. */
const CUT_ORDER = 1;

/**
 * Meshes drawn after the cut, so they show through it: anything solid that
 * goes through tunnels.
 */
const AFTER_CUT = 2;

/** Blended over the ground: after the sea (1). */
export const LINING_ORDER = 1.5;

/** Of something's length, and m more, the radius cut away around it. */
const AROUND = 0.6;
const MARGIN = 14;

/** The drum's floor is this far under what's followed, its top this far over, m. */
const UNDER = 1.6;
const OVER = 10;

/** Seconds to open, and to close up. */
const OPENING = 0.35;

/** The ground's this much darker at the middle of the cut. */
const SHADE = 0.65;

/** From this much of the way out, what's blended in fades to nothing at the edge. */
const FADE_FROM = 0.55;

/** The middle of the cut: what's followed, and how far around it, m: 0 when closed. */
const cutAt = uniform(new Vector3(0, -1e7, 0));
export const cutRadius = uniform(0);

const shear = new Matrix4();

/** 1 at the middle of the cut, fading to 0 at its edge: for what's blended into it. */
export function cutaway(position = positionWorld) {
  const out = position.xz.distance(cutAt.xz).div(max(cutRadius, 0.01));

  return float(1).sub(smoothstep(FADE_FROM, 1, out));
}

/** Has `object` drawn after the ground's cut away, so it's seen in a tunnel. */
export function seenUnderground<T extends Object3D>(object: T) {
  object.renderOrder = AFTER_CUT;

  return object;
}

/** What's to be seen through the ground, as whoever has the camera last said. */
const wanted = {
  at: new Vector3(),
  radius: 0,
  open: false,
  /** Up per metre east, and per metre south: the floor's slope. */
  slope: [0, 0],
};

/**
 * Cuts the ground away around `at`, the middle of something `length` m
 * long in a tunnel, from this frame on; with null, closes it up again. On
 * a `grade` (up per metre ahead) facing `heading` (radians clockwise from
 * north), the cut's floor and top slope with it, as the tunnel's do: on
 * the cable car's 1 in 5, a level floor would be over the tunnel's a few
 * metres downhill, and hide it.
 */
export function seeThrough(
  at: Vector3 | null,
  length = 0,
  grade = 0,
  heading = 0
) {
  wanted.open = at !== null;

  if (!at) return;
  wanted.at.copy(at);
  wanted.radius = length * AROUND + MARGIN;
  wanted.slope = [grade * Math.sin(heading), -grade * Math.cos(heading)];
}

/**
 * The cut itself, to put in the scene: `update` each frame, after the
 * camera's been told what it follows and before the frame's drawn.
 */
export function createCutaway() {
  // A drum, one high and one across, on the origin.
  const drum = new CylinderGeometry(1, 1, 1, 48).translate(0, 0.5, 0);

  // Its far side, where that's behind what's drawn. What's there already
  // is multiplied by its colour: darker toward the middle. Not transparent,
  // so it's drawn in its turn among the solid things, before the vehicles.
  const material = new MeshBasicNodeMaterial({
    depthFunc: GreaterDepth,
    side: BackSide,
    fog: false,
    blending: CustomBlending,
    blendSrc: ZeroFactor,
    blendDst: SrcColorFactor,
    blendSrcAlpha: ZeroFactor,
    blendDstAlpha: OneFactor,
  });

  material.colorNode = vec3(float(1).sub(cutaway().mul(SHADE)));

  const cut = new Mesh(drum, material);
  cut.renderOrder = CUT_ORDER;
  // Placed by hand, to shear it up the slope.
  cut.matrixAutoUpdate = false;
  // Shut, it's a point: drawn all the same, so its pipeline's built with
  // the rest and not when something first goes underground.
  cut.frustumCulled = false;
  cut.scale.setScalar(0);

  let opened = 0;

  const update = (delta: number) => {
    opened = Math.min(
      Math.max(opened + ((wanted.open ? 1 : -1) * delta) / OPENING, 0),
      1
    );

    const radius = wanted.radius * opened * opened * (3 - 2 * opened);
    cutRadius.value = radius;
    cutAt.value.copy(wanted.at);
    cut.position.set(wanted.at.x, wanted.at.y - UNDER, wanted.at.z);
    cut.scale.set(radius, radius > 0 ? UNDER + OVER : 0, radius);

    // Rising `slope` per metre across, from its middle: sheared, its walls
    // still upright.
    const [east, south] = wanted.slope;
    cut.matrix
      .makeScale(cut.scale.x, cut.scale.y, cut.scale.z)
      .premultiply(shear.makeShear(east, 0, 0, 0, 0, south))
      .setPosition(cut.position);
    cut.matrixWorldNeedsUpdate = true;
  };

  const dispose = () => {
    drum.dispose();
    material.dispose();
    cutRadius.value = 0;
  };

  return { mesh: cut, update, dispose };
}
