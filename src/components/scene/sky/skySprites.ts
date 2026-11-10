import {
  AdditiveBlending,
  Group,
  InstancedBufferAttribute,
  Sprite,
  SpriteNodeMaterial,
} from "three/webgpu";
import {
  cameraPosition,
  clamp,
  exp,
  float,
  hash,
  instancedBufferAttribute,
  instanceIndex,
  min,
  modelWorldMatrix,
  normalize,
  pow,
  select,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import { overcast } from "../environment";
import { hazeTransmittance } from "../haze";
import { devicePixelAngle } from "../landmarks/common";

// Points of light in the sky: stars, planets and satellites, as additive
// sprites by magnitude. They ride on a group that follows the camera, at
// SKY_RADIUS, and are drawn at the far plane's depth whatever that is, so
// the ground hides them, the clouds (composited by depth) cover them, and
// the fog leaves them be.

/**
 * After the camera's moved for the frame (0.5), before it's drawn (1): the
 * sky goes with the camera.
 */
export const SKY_PRIORITY = 0.75;

/** Their distance from the camera, m: anything inside the far plane. */
export const SKY_RADIUS = 10_000;

/**
 * The faintest magnitude that shows: past -10 by day, nothing; ~6.5 on a
 * dark night: generous for under a city, so the sky reads as full. Set from the sun.
 */
export const limitingMagnitude = uniform(-10);

/** Haze is reckoned along the line of sight this far, m, as the sky's. */
const HAZE_REACH = 20_000;

/**
 * Sky's limiting magnitude for the sun at `altitude` degrees: the first
 * stars at the end of civil twilight, all that will show by the end of
 * nautical.
 */
export function limitingMagnitudeFor(altitude: number) {
  const t = Math.min(Math.max((-2 - altitude) / 12, 0), 1);

  return -6 + 12.5 * t * t * (3 - 2 * t);
}

/**
 * How bright a point of magnitude `m` shows, 0..1: those just under the
 * limit come in gently.
 */
export const visibility = (m) =>
  smoothstep(0, 1.5, limitingMagnitude.sub(m)).mul(float(1).sub(overcast));

/**
 * Sprites for `capacity` points: each a direction in its group's frame and
 * a magnitude (xyz, w). Those before `twinkling` scintillate, more so low
 * down; planets and satellites go after them.
 */
export function createSkySprites(capacity: number, twinkling = 0) {
  const points = new InstancedBufferAttribute(
    new Float32Array(capacity * 4),
    4
  );

  const point = instancedBufferAttribute<"vec4">(points, "vec4");
  const m = point.w;

  const material = new SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  material.fog = false;
  // As far as anything goes, behind whatever's drawn.
  material.depthNode = float(1);
  material.positionNode = point.xyz.mul(SKY_RADIUS);

  // A few device pixels across, the brightest more: a Gaussian whose sigma
  // is under a pixel at the faint end, so it doesn't crawl as it moves.
  const width = clamp(float(3.6).sub(m.mul(0.4)), 3, 6);
  material.scaleNode = width.mul(devicePixelAngle).mul(SKY_RADIUS);

  const direction = normalize(modelWorldMatrix.mul(vec4(point.xyz, 0)).xyz);

  // Scintillation: a few percent overhead, a quarter near the horizon.
  const seed = hash(instanceIndex);
  const low = float(1).sub(direction.y.clamp(0, 1));

  const twinkle = select(
    instanceIndex.lessThan(twinkling),
    sin(time.mul(seed.mul(9).add(6)).add(seed.mul(40)))
      .mul(low.mul(low).mul(0.25).add(0.04))
      .add(1),
    float(1)
  );

  // Flux, flattened (a magnitude is 0.4 dex; drawn as 0.16) and lifted, so the
  // faint still read beside Sirius; Venus and Jupiter cap out, blooming.
  const brightness = varying(
    min(pow(float(10), m.mul(-0.16)).mul(1.5), 4)
      .mul(visibility(m))
      .mul(
        hazeTransmittance(
          cameraPosition,
          cameraPosition.add(direction.mul(HAZE_REACH))
        )
      )
      .mul(smoothstep(-0.01, 0.04, direction.y))
      .mul(twinkle)
  );

  const r = uv().sub(0.5).length().mul(2);

  material.colorNode = vec3(
    brightness.mul(exp(r.mul(r).mul(-4)).mul(smoothstep(1, 0.85, r)))
  );

  const sprite = new Sprite(material);
  sprite.count = 0;
  sprite.frustumCulled = false;
  sprite.renderOrder = -1;

  return { sprite, points };
}

/**
 * A group for sky sprites, placed by hand each frame: on the camera, and
 * for the stars, turned with the Earth.
 */
export function createSkyGroup() {
  const group = new Group();
  group.matrixAutoUpdate = false;

  return group;
}
