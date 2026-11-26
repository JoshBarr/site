import {
  DoubleSide,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Vector2,
  Vector3,
} from "three/webgpu";
import {
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraViewMatrix,
  cos,
  cross,
  exp,
  float,
  floor,
  hash,
  instanceIndex,
  max,
  min,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  step,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import { sunUnderCloud } from "../cloudLight";
import { moonlit, seaLevel, sunDirection, sunIntensity } from "../environment";
import { hazeColor, hazeTransmittance, phase } from "../haze";
import { pixelAngle } from "../landmarks/common";
import { sceneDepthNode } from "../overClouds";
import { NOZZLE_HEIGHT } from "./pontoon";

// The fountain's spray, worked out on the GPU from nothing but the time: each
// drop's flung up from its nozzle again and again, and where it is now is
// where that throw has carried it, the wind dragging it along. A drop is
// only drawn if the pump was running when it was thrown, so the jets climb
// as the pump starts and what's up falls when it stops.
//
// Three kinds of water, as photos show it: one tall, thin jet up the middle;
// a ring of smaller jets round it, arching out over the pontoon's rail; and
// the mist the wind tears off the tall one, drifting away downwind. The
// ring's count, leans and heights are by eye from a photo.
//
// It's drawn over the clouds (../overClouds.ts), not in the scene: the clouds
// are laid over the scene by its depth, and spray leaves none, so against
// the sky they covered it. So it holds itself back behind what's in front by
// the scene's depth, and takes on the haze itself.

/** The tall jet reaches this high above the sea in still air, m. */
export const SPRAY_HEIGHT = 16;

const G = 9.81;

/** The speed up that carries water `height` m. */
const lift = (height: number) => Math.sqrt(2 * G * height);

/** Of the drops, the tall jet's share and the mist's; the ring has the rest. */
const JET_SHARE = 0.3;
const MIST_SHARE = 0.12;

/** The tall jet: its speed, and its lean from upright, radians. */
const JET_SPEED = lift(SPRAY_HEIGHT - NOZZLE_HEIGHT);
const JET_LEAN = (0.6 * Math.PI) / 180;

/** The ring's nozzles, how far out from the middle, m. */
const RING = 16;
const RING_RADIUS = 0.5;

/** Every other one in the ring stands taller and more upright. */
const RING_TALL = { speed: lift(6), lean: (14 * Math.PI) / 180 };
const RING_SHORT = { speed: lift(4.5), lean: (25 * Math.PI) / 180 };

/** A ring jet's waver about its line, radians. */
const RING_WAVER = (2 * Math.PI) / 180;

/**
 * How long a drop takes to catch the wind's speed across, s: the tall jet's
 * water, thrown hard and close, holds its line longer than the ring's.
 */
const JET_DRAG = 3;
const RING_DRAG = 1.5;

/** How fast each one's water spreads out as it falls, past the top, m/s. */
const JET_BREAKUP = 1.2;
const RING_BREAKUP = 0.8;

/** Mist: torn off this high up the jet, m; how long it lasts, s. */
const MIST_FROM = 3;
const MIST_LIFE: [number, number] = [2, 5];

/** How fast mist sinks, and spreads, m/s. */
const MIST_SINK: [number, number] = [-0.3, 1.4];
const MIST_SPREAD = 0.8;

/** Mist goes slower than the wind, each puff by its own share of it. */
const MIST_DRIFT: [number, number] = [0.5, 1];

/** Drawn this wide, m, at a drop's throw and at its fall. */
const JET_SIZE: [number, number] = [0.1, 2];
const RING_SIZE: [number, number] = [0.05, 0.25];
const MIST_SIZE: [number, number] = [2, 7];

/** Each one's opacity, where it's its own width or more on screen. */
const JET_OPACITY = 0.35;
const RING_OPACITY = 0.45;
const MIST_OPACITY = 0.03;

/**
 * Of the tall jet's water, once it's over the top and falling as spray, the
 * opacity left: it's spread into a veil, not a stream.
 */
const VEIL = 0.3;

/**
 * Once the pump stops, how long till the spray's all gone, s: the tall
 * jet's last throw down in the sea, and the last mist thinned away.
 */
export const SETTLES =
  Math.max(
    (JET_SPEED + Math.sqrt(JET_SPEED ** 2 + 2 * G * NOZZLE_HEIGHT)) / G,
    MIST_LIFE[1]
  ) + 1;

/**
 * How far downwind the spray can reach, per m/s of wind: mist, carried at
 * the most the wind's own speed for its whole life.
 */
export const DRIFTS = MIST_DRIFT[1] * MIST_LIFE[1];

/** A drop's streak is how far it goes in this long: motion blur, s. */
const EXPOSURE = 1 / 12;

/** Drawn at least this many pixels across, opacity cut to match. */
const MIN_PIXELS = 1.5;

/** The pump takes this long to come up to pressure, s. */
const SPIN_UP = 8;

/** How bright the sky's light makes the spray, and the sun's on it. */
const SKY = 1.6;
const SUN = 0.9;

/** At night the floodlights at its foot light it, fading up the jets. */
const FLOOD = 6;
const FLOOD_FALL = 16;

/**
 * `count` drops of spray thrown up from the pontoon at world `centre` (x
 * and z; its height's the tide's, in seaLevel). Returns the mesh and the
 * uniforms the Fountain keeps.
 */
export function createSpray(centre: Vector3, count: number) {
  /** The scene's clock, s from when the fountain mounted. */
  const clock = uniform(0);
  /** When the pump last started, and stopped (far off while it runs), s. */
  const started = uniform(-1e9);
  const stopped = uniform(-1e9);
  /** The wind at the fountain, m/s, x east and z south. */
  const wind = uniform(new Vector2());
  /** 0..1: how far into the night, its floodlights coming on with it. */
  const lights = uniform(0);
  // Faded out as it gets too small to draw, so it doesn't blink off.
  const fade = uniform(1);
  const uniforms = { clock, started, stopped, wind, lights, fade };

  const seed = float(instanceIndex).mul(11);
  const random = (k: number) => hash(seed.add(k));

  // Which kind each drop is, 1 or 0.
  const pick = random(0);
  const jet = float(1).sub(step(JET_SHARE, pick));
  const mist = step(1 - MIST_SHARE, pick);
  const ring = float(1).sub(jet).sub(mist);

  // A ring drop's nozzle, every other one tall.
  const nozzle = floor(random(1).mul(RING));
  const tall = nozzle.mod(2);

  // Each drop's speed and lean are its own, so its time aloft is.
  const speed = jet
    .mul(mix(0.94, 1, random(2)).mul(JET_SPEED))
    .add(
      ring
        .mul(mix(RING_SHORT.speed, RING_TALL.speed, tall))
        .mul(mix(0.96, 1.04, random(2)))
    );

  const lean = jet.mul(random(3).mul(JET_LEAN)).add(
    ring.mul(
      mix(RING_SHORT.lean, RING_TALL.lean, tall).add(
        random(3)
          .sub(0.5)
          .mul(RING_WAVER * 2)
      )
    )
  );

  // Up from the nozzle and down to the sea, at full pressure; mist lasts
  // its own while.
  const rise = speed.mul(cos(lean));

  const aloft = rise
    .add(sqrt(rise.mul(rise).add(2 * G * NOZZLE_HEIGHT)))
    .div(G);

  const lasts = mix(...MIST_LIFE, random(7));
  const period = mix(aloft, lasts, mist);

  // Thrown again each time it's back down: so far into this throw.
  const since = clock.add(random(4).mul(period));
  const round = floor(since.div(period));
  const age = since.sub(round.mul(period));
  const thrown = clock.sub(age);
  const fresh = hash(seed.add(round.mul(13.17)));

  // Weaker while the pump comes up to pressure.
  const pressure = mix(0.35, 1, smoothstep(0, SPIN_UP, thrown.sub(started)));
  const running = step(started, thrown).mul(step(thrown, stopped));

  // The tall jet's drops go any way round; the ring's along their nozzle.
  const turn = mix(
    fresh.mul(2 * Math.PI),
    nozzle.add(fresh.sub(0.5).mul(0.1)).mul((2 * Math.PI) / RING),
    ring
  );

  const around = vec3(cos(turn), 0, sin(turn));

  // Thrown: up and out, the throw across dying away as the drop takes up
  // the wind's speed, and over the top, breaking up into a wider fall.
  const up = speed.mul(pressure).mul(cos(lean));
  const out = speed.mul(pressure).mul(sin(lean));
  const landed = up.add(sqrt(up.mul(up).add(2 * G * NOZZLE_HEIGHT))).div(G);
  const drag = mix(float(RING_DRAG), float(JET_DRAG), jet);
  const caught = drag.mul(float(1).sub(exp(age.div(drag.negate()))));
  const falling = max(age.sub(up.div(G)), 0);

  const breakup = mix(0.3, 1, random(5)).mul(
    mix(float(RING_BREAKUP), float(JET_BREAKUP), jet)
  );

  const reach = out
    .mul(caught)
    .add(breakup.mul(falling))
    .add(ring.mul(RING_RADIUS));

  const flung = around
    .mul(reach)
    .add(vec3(wind.x, 0, wind.y).mul(age.sub(caught)))
    .add(
      vec3(
        0,
        up
          .mul(age)
          .sub(age.mul(age).mul(G / 2))
          .add(NOZZLE_HEIGHT),
        0
      )
    );

  // Mist: torn off somewhere up the jet, as high as the pump has it, and
  // carried off by the wind, each puff its own way: some lag, some sink,
  // some lift, so the cloud of it frays at its edges, not in a line.
  const torn = mix(MIST_FROM, SPRAY_HEIGHT, sqrt(random(6))).mul(
    pressure.mul(pressure)
  );

  const sway = vec3(cos(turn), random(9).sub(0.5).mul(1.4), sin(turn));

  const drifted = sway
    .mul(age.mul(MIST_SPREAD))
    .add(vec3(wind.x, 0, wind.y).mul(age.mul(mix(...MIST_DRIFT, random(8)))))
    .add(vec3(0, torn.sub(age.mul(mix(...MIST_SINK, random(10)))), 0));

  const offset = mix(flung, drifted, mist);
  const height = offset.y;

  const middle = offset.add(vec3(centre.x, seaLevel, centre.z));

  // Spreading as it goes.
  const through = min(age.div(mix(landed, lasts, mist)), 1);

  // The tall jet's water, falling, has broken up into a soft veil; mist
  // is soft throughout.
  const fallen = jet.mul(smoothstep(0.35, 0.9, through));
  const soft = max(fallen, mist);

  const size = jet
    .mul(mix(...JET_SIZE, through.mul(through)))
    .add(ring.mul(mix(...RING_SIZE, through)))
    .add(mist.mul(mix(...MIST_SIZE, through)));

  const toCamera = cameraPosition.sub(middle);
  const distance = toCamera.length();
  const width = max(size, distance.mul(pixelAngle).mul(MIN_PIXELS));
  const shrink = size.div(width);

  // A thrown drop's gone into the sea once it's down; mist thins away all
  // its life. What's soft fades as it nears the water, not cut off at it.
  const thinning = float(1).sub(through);

  const alive = mix(
    step(age, landed).mul(smoothstep(0, 0.08, age)),
    smoothstep(0, 0.8, age).mul(thinning.mul(thinning)),
    mist
  ).mul(step(0, height));

  const opacity = jet
    .mul(JET_OPACITY)
    .add(ring.mul(RING_OPACITY))
    .add(mist.mul(MIST_OPACITY))
    .mul(mix(1, VEIL, fallen))
    .mul(mix(float(1), smoothstep(0, size.mul(0.5), height), soft))
    .mul(shrink.mul(shrink))
    .mul(alive)
    .mul(running)
    .mul(fade);

  // Drops not in the air collapse to nothing, sparing the fill.
  const shown = step(0.001, opacity);

  // A thrown drop's drawn as a streak along its way, so a jet reads as a
  // stream, not a string of beads; mist as a puff, square to the camera.
  const slowing = exp(age.div(drag.negate()));

  const moving = around
    .mul(out.mul(slowing).add(breakup.mul(step(up.div(G), age))))
    .add(vec3(wind.x, 0, wind.y).mul(float(1).sub(slowing)))
    .add(vec3(0, up.sub(age.mul(G)), 0));

  const level = normalize(cross(vec3(0, 1, 0), toCamera));
  const upright = normalize(cross(toCamera, level));
  const along = normalize(mix(moving.add(vec3(0, 1e-3, 0)), upright, mist));
  const across = normalize(cross(along, toCamera));

  const length = max(
    width,
    moving.length().mul(EXPOSURE).mul(float(1).sub(soft))
  );

  const corner = positionGeometry.xy.mul(shown);

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  // Its own pass has no fog: the haze, by hand.
  material.fog = false;

  const position = middle
    .add(across.mul(corner.x.mul(width)))
    .add(along.mul(corner.y.mul(length)));

  material.positionNode = position;
  const viewZ = varying(cameraViewMatrix.mul(vec4(position, 1)).z);

  const inFront = step(
    perspectiveDepthToViewZ(
      sceneDepthNode.sample(screenUV).r,
      cameraNear,
      cameraFar
    ),
    viewZ
  );

  // The sky's light, as the haze has it that way, and the sun's through the
  // drops, bright toward it as spray is; at night, the floodlights.
  const view = toCamera.negate();
  const forward = phase(normalize(view).dot(sunDirection), 0.6);

  // As much of the sun as gets under the cloud (../cloudLight.ts).
  const sunlit = sunIntensity
    .mul(sunUnderCloud)
    .mul(mix(1, 0.3, moonlit))
    .mul(forward.mul(4 * Math.PI).add(0.4))
    .mul(SUN);

  const flood = lights.mul(FLOOD).mul(exp(height.div(-FLOOD_FALL)));

  const lit = hazeColor(view).mul(SKY).add(sunlit).add(flood);
  const clear = hazeTransmittance(cameraPosition, middle);

  material.colorNode = varying(mix(hazeColor(view), lit, clear));

  // Drops a soft-edged disc; veil and mist a gaussian, gone by the edge.
  const r = uv().sub(0.5).length().mul(2);
  const disc = smoothstep(1, 0, r).pow(1.5);
  const puff = exp(r.mul(r).mul(-4)).mul(smoothstep(1, 0.7, r));
  material.opacityNode = varying(opacity)
    .mul(mix(disc, puff, varying(soft)))
    .mul(inFront);

  const plane = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(plane.getIndex());

  for (const [name, values] of Object.entries(plane.attributes)) {
    geometry.setAttribute(name, values);
  }

  geometry.instanceCount = count;

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;

  return { mesh, uniforms };
}
