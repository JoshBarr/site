import {
  DataTexture,
  DoubleSide,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
} from "three/webgpu";
import {
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraViewMatrix,
  cross,
  float,
  fract,
  hash,
  instanceIndex,
  max,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  pow,
  positionGeometry,
  screenUV,
  smoothstep,
  sqrt,
  step,
  time,
  uv,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import { hazeColor } from "../haze";
import { pixelAngle } from "../landmarks/common";
import type { CloudLayerUniforms } from "./density";
import { rainfall, RainUniforms } from "./rain";

/**
 * Drops fill a box this wide around the camera, wrapping at its sides, m.
 * Then sparser, bigger boxes around that, each this many times wider, so
 * the rain reaches the ground from up high. Each box shows the shell its
 * inner one leaves off from; with equal counts, each shell puts as many drops
 * on screen as the last.
 */
const DROP_BOX = 50;
const CASCADES = 3;
const CASCADE_GROWTH = 4;

/** Drops are drawn out to this far from the camera, m. */
export const DROP_REACH =
  (DROP_BOX * Math.pow(CASCADE_GROWTH, CASCADES - 1)) / 2;

/** A streak is how far its drop moves in this long: motion blur, s. */
const EXPOSURE = 1 / 20;

/**
 * Drawn this wide, m, or a couple of pixels if that's wider, with opacity
 * cut to match (gently, so distant drops still show): several times a real
 * drop, which would barely show.
 */
const DROP_WIDTH = 0.012;
const MIN_PIXELS = 2;

/** Far off, a streak is at least this many pixels long, so it reads as one. */
const MIN_LENGTH_PIXELS = 10;
const OPACITY = 0.7;

/** Brighter than the haze: they catch the light of the whole sky. */
const BRIGHTNESS = 2.2;

/** Fall speed varies with drop size, by this much either way. */
const SPEED_SPREAD = 0.25;

/**
 * Rain streaks near the camera, `count` of them at most. They're seen through
 * their own pass, after the clouds, so `sceneDepth` (the scene pass's depth)
 * stands in for the depth test. Each drop wraps around a box that follows the
 * camera but stays put in the world, so moving through the rain shows it.
 */
export function createDrops({
  weather,
  low,
  rain,
  sceneDepth,
  count,
}: {
  weather: DataTexture;
  low: CloudLayerUniforms;
  rain: RainUniforms;
  sceneDepth: any;
  count: number;
}) {
  const seed = float(instanceIndex).mul(4);
  const random = (k: number) => hash(seed.add(k));

  const speed = mix(1 - SPEED_SPREAD, 1 + SPEED_SPREAD, random(3));

  const velocity = vec3(
    rain.wind.x,
    rain.fall.mul(speed).negate(),
    rain.wind.y
  );

  // Interleaved, so a lighter rate drawing fewer drops thins every box.
  const cascade = float(instanceIndex.mod(CASCADES));
  const box = pow(float(CASCADE_GROWTH), cascade).mul(DROP_BOX);
  const home = vec3(random(0), random(1), random(2)).mul(box);
  const moved = home.add(velocity.mul(time));

  const centre = cameraPosition.add(
    fract(moved.sub(cameraPosition).div(box).add(0.5)).sub(0.5).mul(box)
  );

  const toCamera = cameraPosition.sub(centre);
  const distance = toCamera.length();
  const pixel = distance.mul(pixelAngle);
  const width = max(float(DROP_WIDTH), pixel.mul(MIN_PIXELS));

  const length = max(
    velocity.length().mul(EXPOSURE),
    pixel.mul(MIN_LENGTH_PIXELS)
  );

  // Fades in where the box inside fades out (the first, off the lens) and
  // out before the edge, where drops wrap.
  const inner = box.div(CASCADE_GROWTH);

  const fadeIn = cascade
    .equal(0)
    .select(
      smoothstep(0.3, 1.5, distance),
      smoothstep(inner.mul(0.3), inner.mul(0.5), distance)
    );

  // Only where it's raining.
  const opacity = rainfall(weather, low, rain, centre)
    .mul(sqrt(float(DROP_WIDTH).div(width)))
    .mul(fadeIn)
    .mul(smoothstep(box.mul(0.5), box.mul(0.3), distance))
    .mul(OPACITY);

  // Drops that can't be seen collapse to nothing, sparing the fill.
  const shown = step(0.002, opacity);

  // A quad along the direction of fall, turned to face the camera.
  const along = normalize(velocity);
  const across = normalize(cross(along, toCamera.add(vec3(1e-3, 0, 0))));
  const corner = positionGeometry.xy.mul(shown);

  const position = centre
    .add(along.mul(corner.y.mul(length)))
    .add(across.mul(corner.x.mul(width)));

  const viewZ = varying(cameraViewMatrix.mul(vec4(position, 1)).z);

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  // They're within a few tens of metres: no haze to speak of.
  material.fog = false;
  material.positionNode = position;
  material.colorNode = varying(hazeColor(toCamera.negate()).mul(BRIGHTNESS));

  const inFront = step(
    perspectiveDepthToViewZ(
      sceneDepth.sample(screenUV).r,
      cameraNear,
      cameraFar
    ),
    viewZ
  );

  // Soft across, tapering at the ends.
  const sides = smoothstep(1, 0.4, abs(uv().x.mul(2).sub(1)));
  const ends = smoothstep(1, 0.3, abs(uv().y.mul(2).sub(1)));
  material.opacityNode = varying(opacity).mul(sides).mul(ends).mul(inFront);

  const plane = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(plane.getIndex());

  for (const [name, values] of Object.entries(plane.attributes)) {
    geometry.setAttribute(name, values);
  }

  geometry.instanceCount = count;

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;

  return mesh;
}
