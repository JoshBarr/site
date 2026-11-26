import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Vector3,
} from "three/webgpu";
import {
  attribute,
  cameraPosition,
  cross,
  dot,
  exp,
  max,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  smoothstep,
  uniform,
  uv,
  varying,
  vec3,
} from "three/tsl";
import { sunUnderCloud } from "../cloudLight";
import { moonlit, sunDirection, sunIntensity } from "../environment";
import { hazeColor, phase } from "../haze";
import { pixelAngle } from "../landmarks/common";
import { BUCKETS, OUTLETS, WATER_LEVEL } from "./layout";
import { MOUTH, MOUTH_RADIUS, place, shell, type V3 } from "./shape";
import { POOL, toLocal } from "./site";
import type { Tipping } from "./tipping";

// The fountain's water in the air: a thread from each feed outlet, a sheet
// off each bucket's lip as it pours, flung on by the bucket's swing, and
// splashes where it lands. Drops are worked out here, a frame at a time, in
// the fountain's frame, caught by any bucket whose mouth they fall into,
// and dropped into the pool or onto the paving; the wind carries them as it
// catches them, so on a windy day the mall gets wet. Each is drawn as a soft
// streak along its motion.

/** The most drops in the air at once. */
const MOST = 4000;

/** Drops thrown per kg poured, and per second from each outlet. */
const PER_KG = 60;
const FROM_OUTLET = 90;

const G = 9.81;

/** How long the wind takes to carry a drop at its own speed, s. */
const STREAM_DRAG = 2.5;
const SPLASH_DRAG = 0.5;

/** Pouring water leaves the lip at this speed, m/s, as well as its swing. */
const POUR_SPEED = 0.6;

/** A landing's chance of throwing splashes, on a bucket, the pool, paving. */
const SPLASH_BUCKET = 0.35;
const SPLASH_POOL = 0.25;
const SPLASH_PAVING = 0.15;

/** Drawn this wide, m: a stream's drop, and a splash's. */
const STREAM_SIZE = 0.09;
const SPLASH_SIZE = 0.035;

/** Each drop's opacity, and its streak's length per m/s, s. */
const STREAM_OPACITY = 0.22;
const SPLASH_OPACITY = 0.45;
const STREAK = 0.05;

/** Drawn at least this many pixels across, opacity cut to match. */
const MIN_PIXELS = 1.2;

/** How bright the sky's light makes it, the sun's through it, at night. */
const SKY = 1.4;
const SUN = 0.8;
const FLOOD = 1;
const FLOOD_FALL = 3;

const STREAM = 0;
const SPLASH = 1;

/** The pool's edge in the fountain's frame, for whether a drop's over it. */
const POOL_EDGE = POOL.map(([e, n]) => toLocal(e, n));

function inPool(x: number, z: number) {
  let inside = false;

  for (let i = 0, j = POOL_EDGE.length - 1; i < POOL_EDGE.length; j = i++) {
    const [xi, zi] = POOL_EDGE[i];
    const [xj, zj] = POOL_EDGE[j];

    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

/** Each bucket, and its mouth's radius: what falling water must hit. */
const MOUTHS = BUCKETS.map((bucket) => ({
  bucket,
  radius: MOUTH_RADIUS * bucket.size,
}));

/**
 * `count` drops' worth of water in the air; `update(dt, tipping, wind,
 * eye)` moves them on, throws new ones, and readies them to draw. `wind`
 * is in the fountain's frame (x, z), m/s; `eye` the camera, in it too.
 */
export function createSpray() {
  const position = new Float32Array(MOST * 3);
  const velocity = new Float32Array(MOST * 3);
  const kind = new Uint8Array(MOST);
  const age = new Float32Array(MOST);
  let live = 0;

  // What's drawn: where (and how wide), and its motion (and opacity).
  const where = new Float32Array(MOST * 4);
  const motion = new Float32Array(MOST * 4);
  const whereAttribute = new InstancedBufferAttribute(where, 4);
  const motionAttribute = new InstancedBufferAttribute(motion, 4);

  /** Owed drops, by source, carried from frame to frame. */
  const owed = new Float32Array(BUCKETS.length + OUTLETS.length);

  let seed = 1;

  const random = () => {
    seed = (seed * 16807) % 2147483647;

    return seed / 2147483647;
  };

  function throwDrop([x, y, z]: V3, [vx, vy, vz]: V3, type: number) {
    if (live >= MOST) return;

    const i = live++;
    position.set([x, y, z], i * 3);
    velocity.set([vx, vy, vz], i * 3);
    kind[i] = type;
    age[i] = 0;
  }

  function splash(x: number, y: number, z: number, chance: number, up: number) {
    if (random() > chance) return;

    const count = 1 + Math.floor(random() * 3);

    for (let k = 0; k < count; k++) {
      const turn = random() * 2 * Math.PI;
      const out = 0.4 + random() * 1.2;
      throwDrop(
        [x, y + 0.02, z],
        [Math.cos(turn) * out, up * (0.5 + random()), Math.sin(turn) * out],
        SPLASH
      );
    }
  }

  function emit(dt: number, tipping: Tipping) {
    OUTLETS.forEach(({ at }, o) => {
      const slot = BUCKETS.length + o;
      owed[slot] += FROM_OUTLET * dt;

      while (owed[slot] >= 1) {
        owed[slot] -= 1;
        const r = 0.012;
        throwDrop(
          [at[0] + (random() - 0.5) * r, at[1], at[2] + (random() - 0.5) * r],
          [
            (random() - 0.5) * 0.06,
            -0.6 - random() * 0.3,
            (random() - 0.5) * 0.06,
          ],
          STREAM
        );
      }
    });

    BUCKETS.forEach((bucket, b) => {
      const pouring = tipping.pour[b];

      if (pouring <= 0) {
        owed[b] = 0;

        return;
      }

      owed[b] += pouring * PER_KG * dt;
      const tip = tipping.tip[b];
      const spin = tipping.spin[b];

      while (owed[b] >= 1) {
        owed[b] -= 1;
        // Across the front of its rim, out over the lip.
        const phi = (random() - 0.5) * 1.3;
        const rim = shell(1, phi);
        const at = place(bucket, rim, tip);
        const ahead = place(bucket, rim, tip + 0.01);
        const sx = ((ahead[0] - at[0]) / 0.01) * spin;
        const sy = ((ahead[1] - at[1]) / 0.01) * spin;
        const sz = ((ahead[2] - at[2]) / 0.01) * spin;
        const out = POUR_SPEED * (0.6 + random() * 0.8);
        const c = Math.cos(bucket.facing + phi * 0.5);
        const s = Math.sin(bucket.facing + phi * 0.5);

        throwDrop(at, [sx + s * out, sy - 0.2, sz + c * out], STREAM);
      }
    });
  }

  function move(dt: number, tipping: Tipping, windX: number, windZ: number) {
    let kept = 0;

    for (let i = 0; i < live; i++) {
      const p = i * 3;
      let x = position[p];
      let y = position[p + 1];
      let z = position[p + 2];
      let vx = velocity[p];
      let vy = velocity[p + 1];
      let vz = velocity[p + 2];
      const type = kind[i];
      const drag = dt / (type === STREAM ? STREAM_DRAG : SPLASH_DRAG);

      vx += (windX - vx) * drag;
      vz += (windZ - vz) * drag;
      vy -= G * dt;

      const wasY = y;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      age[i] += dt;

      let gone = age[i] > 4;

      // Into a bucket's mouth, while it's up to catch it.
      if (!gone && vy < 0 && type === STREAM) {
        for (let b = 0; b < MOUTHS.length; b++) {
          if (tipping.tip[b] > 0.6) continue;

          const { bucket, radius } = MOUTHS[b];
          const mouth = place(bucket, MOUTH, tipping.tip[b]);

          if (wasY >= mouth[1] && y < mouth[1]) {
            if (Math.hypot(x - mouth[0], z - mouth[2]) < radius) {
              gone = true;
              splash(x, mouth[1], z, SPLASH_BUCKET, 1.2);
              break;
            }
          }
        }
      }

      if (!gone && y < WATER_LEVEL && inPool(x, z)) {
        gone = true;

        if (type === STREAM) splash(x, WATER_LEVEL, z, SPLASH_POOL, 1.5);
      } else if (!gone && y < 0) {
        gone = true;

        if (type === STREAM) splash(x, 0, z, SPLASH_PAVING, 1);
      }

      if (gone) continue;

      const k = kept * 3;
      position[k] = x;
      position[k + 1] = y;
      position[k + 2] = z;
      velocity[k] = vx;
      velocity[k + 1] = vy;
      velocity[k + 2] = vz;
      kind[kept] = type;
      age[kept] = age[i];
      kept++;
    }

    live = kept;
  }

  /** Fills the drawn buffers from the drops in the air. */
  function draw() {
    for (let i = 0; i < live; i++) {
      const p = i * 3;
      const q = i * 4;
      const stream = kind[i] === STREAM;
      where[q] = position[p];
      where[q + 1] = position[p + 1];
      where[q + 2] = position[p + 2];
      where[q + 3] = stream ? STREAM_SIZE : SPLASH_SIZE;
      motion[q] = velocity[p];
      motion[q + 1] = velocity[p + 1];
      motion[q + 2] = velocity[p + 2];
      // Each fades in over its first moment, off the lip.
      motion[q + 3] =
        (stream ? STREAM_OPACITY : SPLASH_OPACITY) * Math.min(age[i] / 0.05, 1);
    }

    whereAttribute.clearUpdateRanges();
    motionAttribute.clearUpdateRanges();
    whereAttribute.addUpdateRange(0, live * 4);
    motionAttribute.addUpdateRange(0, live * 4);
    whereAttribute.needsUpdate = true;
    motionAttribute.needsUpdate = true;
    geometry.instanceCount = live;
  }

  const plane = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(plane.getIndex());

  for (const [name, values] of Object.entries(plane.attributes)) {
    geometry.setAttribute(name, values);
  }

  geometry.setAttribute("dropAt", whereAttribute);
  geometry.setAttribute("dropGoing", motionAttribute);
  geometry.instanceCount = 0;

  const { material, eye, lights } = createSprayMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;

  return {
    mesh,
    eye,
    lights,
    update(dt: number, tipping: Tipping, wind: [number, number]) {
      emit(dt, tipping);
      move(dt, tipping, ...wind);
      draw();
    },
    /** Lets every drop fall at once: none left in the air. */
    clear() {
      live = 0;
      owed.fill(0);
      geometry.instanceCount = 0;
    },
    get count() {
      return live;
    },
    dispose() {
      geometry.dispose();
      plane.dispose();
      material.dispose();
    },
  };
}

function createSprayMaterial() {
  /** The camera, in the fountain's frame. */
  const eye = uniform(new Vector3());

  /** 0..1: how far into the night, the pool's lights coming on. */
  const lights = uniform(0);

  const where = attribute<"vec4">("dropAt", "vec4");
  const motion = attribute<"vec4">("dropGoing", "vec4");
  const centre = where.xyz;

  // Square to the eye, drawn out along the drop's motion across the view.
  const toEye = eye.sub(centre);
  const distance = toEye.length();
  const look = toEye.div(distance);
  const across = motion.xyz.sub(look.mul(dot(motion.xyz, look)));
  const upright = vec3(0, 1, 0).sub(look.mul(look.y));
  const along = normalize(across.add(upright.mul(0.02)));
  const side = normalize(cross(along, look));

  const width = max(where.w, distance.mul(pixelAngle).mul(MIN_PIXELS));
  const length = width.add(across.length().mul(STREAK));
  const corner = positionGeometry.xy;

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  material.positionNode = centre
    .add(side.mul(corner.x.mul(width)))
    .add(along.mul(corner.y.mul(length)));

  // The sky's light, as the haze has it that way, and the sun's through
  // the drops, bright toward it as spray is; at night the pool's lights.
  const view = positionWorld.sub(cameraPosition);
  const forward = phase(normalize(view).dot(sunDirection), 0.6);

  // As much of the sun as gets under the cloud (../cloudLight.ts).
  const sunlit = sunIntensity
    .mul(sunUnderCloud)
    .mul(mix(1, 0.3, moonlit))
    .mul(forward.mul(4 * Math.PI).add(0.4))
    .mul(SUN);

  const flood = lights.mul(FLOOD).mul(exp(centre.y.div(-FLOOD_FALL)));

  material.colorNode = varying(hazeColor(view).mul(SKY).add(sunlit).add(flood));

  const opacity = motion.w.mul(pow(where.w.div(width), 2));
  const r = uv().sub(0.5).length().mul(2);

  material.opacityNode = varying(opacity).mul(smoothstep(1, 0, r).pow(1.5));

  return { material, eye, lights };
}
