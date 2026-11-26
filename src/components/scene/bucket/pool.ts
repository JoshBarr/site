import {
  BufferGeometry,
  Float32BufferAttribute,
  MeshBasicNodeMaterial,
  ShapeUtils,
  Vector2,
} from "three/webgpu";
import {
  cameraPosition,
  cos,
  dot,
  exp,
  float,
  max,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  reflector,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import {
  cloudShadow,
  nearShadow,
  skylight,
  sunDirection,
  sunIntensity,
  sunShadow,
} from "../environment";
import { hazeColor } from "../haze";
import { WATER_LEVEL } from "./layout";
import { MALL_BEARING, POOL, toLocal } from "./site";

// The pool under the fountain: shallow water over a pale-painted floor,
// mirroring what stands over it (the fountain, the mall's buildings, the
// sky), its surface stirred where the buckets pour into it. The mirror's a
// planar reflector at the water's level; up close only, as it's a second
// render of what the sea's mirror sees.

/** The floor's paint, as much of the light on it as comes back up. */
const FLOOR = 0.2;

/**
 * Seen from above, a pool over a pale floor shows its floor more than its
 * mirror; seen across, its mirror. But the fountain in it is what catches
 * the eye, so the mirror's never under this share.
 */
const LEAST_MIRROR = 0.45;

/** How far a ripple's tilt moves the mirror's image, in its uv. */
const NUDGE = 0.04;

/**
 * At night the pool's lights, under the water round the post, light its
 * floor so there, fading out across it.
 */
const LAMPS = 0.25;

/**
 * Ripples: three trains of them across the pool and rings out from under
 * the cage, as slopes; stronger where the water lands. Wavenumbers, rad/m.
 */
const TRAINS: [angle: number, k: number, slope: number][] = [
  [0.3, 7, 0.03],
  [2.1, 11, 0.025],
  [4.0, 16, 0.02],
];

const RING_K = 9;
const RING_SLOPE = 0.05;

const G = 9.81;

/** The pool's outline at its water level, in the fountain's frame. */
export function createPoolGeometry() {
  const outline = POOL.map(([e, n]) => new Vector2(...toLocal(e, n)));
  const triangles = ShapeUtils.triangulateShape(outline, []);
  const position = outline.flatMap(({ x, y }) => [x, WATER_LEVEL, y]);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setIndex(triangles.flat());

  return geometry;
}

/**
 * The pool's water: with a mirror (`mirrored`) for up close, without for
 * afar. `clock` (s) moves its ripples; `lights` 0..1 its lamps at night.
 */
export function createPoolMaterial({
  mirrored,
  resolutionScale,
}: {
  mirrored: boolean;
  resolutionScale: number;
}) {
  const clock = uniform(0);
  const lights = uniform(0);

  const material = new MeshBasicNodeMaterial({
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  // The ripples' slope, in the fountain's frame.
  const xz = positionLocal.xz;
  const near = exp(xz.dot(xz).div(-4));

  const trains = TRAINS.map(([angle, k, slope]) => {
    const along = vec2(Math.cos(angle), Math.sin(angle));

    const phase = xz
      .dot(along)
      .mul(k)
      .sub(clock.mul(Math.sqrt(G * k)));

    return along.mul(cos(phase).mul(slope));
  }).reduce((sum, train) => sum.add(train));

  const r = xz.length().max(0.05);
  const ring = cos(r.mul(RING_K).sub(clock.mul(Math.sqrt(G * RING_K))));

  const tilt = trains
    .mul(near.mul(0.7).add(0.3))
    .add(xz.div(r).mul(ring.mul(RING_SLOPE).mul(near)));

  // Turned into the world's frame for the light.
  const b = (MALL_BEARING * Math.PI) / 180;

  const worldTilt = vec2(
    tilt.x.mul(Math.cos(b)).sub(tilt.y.mul(Math.sin(b))),
    tilt.x.mul(Math.sin(b)).add(tilt.y.mul(Math.cos(b)))
  );

  const normal = normalize(vec3(worldTilt.x.negate(), 1, worldTilt.y.negate()));
  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = max(dot(view, normal), 0);
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98));
  const reflected = reflect(view.negate(), normal);

  // SAFETY: shadow() makes a float node; see environment.ts.
  const lit = float(sunShadow as any)
    .mul(nearShadow as any)
    .mul(cloudShadow);

  const irradiance = sunIntensity
    .mul(3)
    .mul(max(sunDirection.y, 0))
    .mul(lit)
    .add(skylight)
    .div(Math.PI);

  const floor = vec3(irradiance.mul(FLOOR)).add(
    lights.mul(LAMPS).mul(near.mul(0.8).add(0.2))
  );

  const mirror = mirrored ? reflector({ resolutionScale }) : null;

  if (mirror) {
    mirror.target.rotateX(-Math.PI / 2);
    mirror.target.position.y = WATER_LEVEL;
  }

  const image = mirror
    ? mirror.sample(mirror.uvNode!.add(tilt.mul(NUDGE))).rgb
    : hazeColor(reflected);

  const glint = pow(max(dot(reflected, sunDirection), 0), 300)
    .mul(6)
    .mul(sunIntensity)
    .mul(lit);

  material.colorNode = mix(floor, image, max(fresnel, LEAST_MIRROR)).add(glint);

  return { material, mirror, clock, lights };
}
