import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  DoubleSide,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Vector2,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import {
  cameraProjectionMatrix,
  cameraViewMatrix,
  cos,
  float,
  Break,
  Fn,
  hash,
  If,
  instancedArray,
  instanceIndex,
  int,
  length,
  Loop,
  max,
  mix,
  mx_noise_float,
  positionGeometry,
  pow,
  screenSize,
  select,
  sin,
  smoothstep,
  texture,
  uniform,
  uint,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { useRenderer } from "../renderer";
import { orbits } from "../landmarks/nearShadow";
import { lensBlur } from "../lens";
import { verticalScale } from "../terrain/Terrain";
import { hazeTransmittance } from "../haze";
import type { TileIndex } from "../terrain/manifest";
import type { TileCache } from "../terrain/TileCache";
import { windVector } from "../weather";
import { fieldTextures, FIELD_SCALE, loadWindField, WindField } from "./field";
import { GroundLookup, groundHeight } from "./ground";

// The wind, drawn as trails blowing over the land and sea: particles carried
// by the forecast's wind as the land turns and slows it (./field.ts), each
// leaving a fading ribbon of where it's been. They're born across the screen,
// wherever it shows the ground, so they're as thick near and far, and each
// runs faster the further from the camera it's born, though not by so much
// that far trails keep up with near ones on screen: from across the harbour
// a breeze looks slow, and a gale still rips.

export interface WindQuality {
  trails: number;
}

export const WIND_DESKTOP: WindQuality = { trails: 7168 };
export const WIND_MOBILE: WindQuality = { trails: 3072 };

/** Points recorded along each trail, and seconds between them. */
const POINTS = 22;
const STEP = 0.1;

/** A particle lives this long, s, plus up to SPREAD more. */
const LIFE = 2.5;
const SPREAD = 2.5;

/** Seconds to fade in, and out at the end of its life. */
const FADE_IN = 0.4;
const FADE_OUT = 0.6;

/** Places tried for a particle each frame it's due to be born. */
const TRIES = 2;

/**
 * Looking for the ground along a ray: MARCH steps, growing, from NEAR times
 * the view distance out, then REFINE halvings of the one it's found in.
 * Closer than that they fade out: right by the lens they'd fill the view.
 */
const MARCH = 32;
const NEAR = 0.1;

/**
 * Trails fade as the lens's depth of field blurs them from BLURRED to
 * BLOTTED of its largest blur: skimming the sea, the near ones would blur
 * into bright blots.
 */
const BLURRED = 0.3;
const BLOTTED = 0.8;
const REFINE = 4;

/**
 * The wind runs faster as the square root of how many PACE_DISTANCE m there
 * are between the camera and where a trail's born: real speed in the street
 * below, ~4.5× across the whole harbour.
 */
const PACE_DISTANCE = 300;

/**
 * Seconds for what goes by the view's distance (the camera to what it's
 * looking at) to follow a change in it.
 */
const VIEW_EASE = 0.5;

/**
 * Seconds for the trails to follow a change in the wind: the stations'
 * readings come every five minutes, and shouldn't swing them round.
 */
const WIND_EASE = 4;

/**
 * Trails are born out to BIRTH_REACH times the view's distance (and no further
 * than MAX_REACH m), and fade from FADE_FROM times it.
 */
const BIRTH_REACH = 4.5;
const FADE_FROM = 2.5;
const MAX_REACH = 30000;

/** Height above the ground, as a fraction of the view distance, m. */
const LIFT = 0.008;
const LIFT_RANGE: [number, number] = [3, 60];

/** And this much more over land, m: the height of its trees and houses. */
const LAND_LIFT = 20;

/** No more than these fractions of the camera's height above the ground. */
const EYE_LIFT = 0.3;
const EYE_LAND_LIFT = 0.5;

/** Width of a trail, CSS px. */
const WIDTH = 1.5;

/**
 * Gusts: cells about GUST_SIZE m across, carried on the wind, that blow up
 * to GUSTINESS harder or softer, and turn it up to SWIRL radians.
 */
const GUST_SIZE = 1500;
const GUSTINESS = 0.35;
const SWIRL = 0.3;

/** How long, in paced seconds, a gust takes to change shape. */
const GUST_CHANGE = 300;

/** At its strongest, near the head. */
const OPACITY = 0.6;

/** m/s: the trails show at their faintest below CALM, fully at GALE (100 km/h). */
const CALM = 1;
const GALE = 28;

/**
 * Index triangles for a ribbon of POINTS + 1 points, two vertices each: x is
 * the point (0 at the head), y the side (±1).
 */
function createRibbon() {
  const positions = new Float32Array((POINTS + 1) * 2 * 3);
  const indices: number[] = [];

  for (let k = 0; k <= POINTS; k++) {
    for (const [s, side] of [-1, 1].entries()) {
      positions.set([k, side, 0], (k * 2 + s) * 3);
    }

    if (k < POINTS) {
      const a = k * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(indices);

  return geometry;
}

function build(
  count: number,
  field: WindField,
  index: TileIndex,
  cache: TileCache,
  lookup: GroundLookup
) {
  const half = index.manifest.rootSize / 2;
  const maps = fieldTextures(field);

  const u = {
    delta: uniform(0),
    wind: uniform(new Vector2()),
    gustOffset: uniform(new Vector2()),
    gustTime: uniform(0),
    frame: uniform(0),
    /** Newest record's slot, whether it's this frame's, and time since it. */
    ring: uniform(0),
    record: uniform(0),
    /** 1 while new particles are born, 0 while the last fade away. */
    spawning: uniform(1),
    fraction: uniform(0),
    worldFromClip: uniform(new Matrix4()),
    eye: uniform(new Vector3()),
    near: uniform(10),
    reach: uniform(10000),
    fadeFrom: uniform(5000),
    lift: uniform(10),
    landLift: uniform(LAND_LIFT),
    halfWidth: uniform(1),
    dim: uniform(1),
  };

  // x, y (lifted ground), z, age
  const heads = instancedArray(count, "vec4");
  // life, shown (0 or 1), speed, pace
  const lives = instancedArray(count, "vec4");
  // x, y, z, speed: POINTS records each, a ring
  const trail = instancedArray(count * POINTS, "vec4");

  const ground = (xz) => groundHeight(lookup, cache.texture, index, xz);
  const uvOf = (p) => p.add(half).div(half * 2);

  /** Where a trail runs: over land, above the trees and houses. */
  const lifted = (xz) =>
    ground(xz).add(
      texture(maps.land, uvOf(xz)).level(float(0)).r.mul(u.landLift)
    );

  /** Surface wind at x/z, m/s, with its gusts. */
  const flow = (p) => {
    const c = texture(maps.flow, uvOf(p))
      .level(float(0))
      .sub(128 / 255)
      .mul(255 / FIELD_SCALE);

    const steady = c.xy.mul(u.wind.x).add(c.zw.mul(u.wind.y));
    const q = vec3(p.sub(u.gustOffset).div(GUST_SIZE), u.gustTime);
    const gust = mx_noise_float(q).mul(GUSTINESS).add(1);
    const turn = mx_noise_float(q.mul(2.3).add(17)).mul(SWIRL);
    const [c1, s1] = [cos(turn), sin(turn)];

    return vec2(
      steady.x.mul(c1).sub(steady.y.mul(s1)),
      steady.x.mul(s1).add(steady.y.mul(c1))
    ).mul(gust);
  };

  const inside = (p) => max(p.x.abs(), p.y.abs()).lessThan(half - 100);

  /**
   * How far along `direction` from the eye the ground is, between the near
   * distance and the reach, or -1: in steps growing with distance, then
   * halving the step it's in.
   */
  const groundAlong = (direction) => {
    const before = u.near.toVar();
    const after = float(-1).toVar();
    const ratio = u.reach.div(u.near);

    Loop(MARCH + 1, ({ i }) => {
      const t = u.near.mul(pow(ratio, float(i).div(MARCH)));
      const p = u.eye.add(direction.mul(t));

      // Already under it where the search starts: it's nearer than that,
      // and nothing's born there.
      If(p.y.lessThan(ground(p.xz)), () => {
        If(i.greaterThan(0), () => {
          after.assign(t);
        });

        Break();
      });

      before.assign(t);
    });

    If(after.greaterThan(0), () => {
      for (let k = 0; k < REFINE; k++) {
        const t = before.add(after).mul(0.5);
        const p = u.eye.add(direction.mul(t));

        If(p.y.lessThan(ground(p.xz)), () => {
          after.assign(t);
        }).Else(() => {
          before.assign(t);
        });
      }
    });

    return after;
  };

  const update = Fn(() => {
    const head = heads.element(instanceIndex).toVar();
    const life = lives.element(instanceIndex).toVar();
    const age = head.w.add(u.delta).toVar();
    const base = instanceIndex.add(uint(u.frame).mul(count)).mul(TRIES * 3);

    If(age.greaterThanEqual(life.x), () => {
      // Born again: somewhere on the ground the screen shows.
      const found = float(0).toVar();
      const spot = vec2(0).toVar();

      for (let attempt = 0; attempt < TRIES; attempt++) {
        // Switched off, none are: those about live out their lives.
        If(found.equal(0).and(u.spawning.equal(1)), () => {
          const r = (k: number) => hash(base.add(attempt * 3 + k));
          const ndc = vec2(r(0), r(1)).mul(2).sub(1);
          const far = u.worldFromClip.mul(vec4(ndc, 1, 1));
          const direction = far.xyz.div(far.w).sub(u.eye).normalize();
          const t = groundAlong(direction);
          const at = u.eye.xz.add(direction.xz.mul(t));

          If(t.greaterThan(0).and(inside(at)), () => {
            spot.assign(at);
            found.assign(1);
          });
        });
      }

      If(found.equal(1), () => {
        const y = lifted(spot);
        const speed = length(flow(spot));
        const start = vec4(spot.x, y, spot.y, speed);

        // Paced by how far off it's born, so far trails still read, though
        // shorter on screen than near ones.
        const pace = max(
          length(vec3(spot.x, y, spot.y).sub(u.eye))
            .div(PACE_DISTANCE)
            .sqrt(),
          1
        );

        heads.element(instanceIndex).assign(vec4(spot.x, y, spot.y, 0));
        lives.element(instanceIndex).assign(
          vec4(
            hash(base.add(TRIES * 3 - 1))
              .mul(SPREAD)
              .add(LIFE),
            1,
            speed,
            pace
          )
        );

        for (let k = 0; k < POINTS; k++) {
          trail.element(instanceIndex.mul(POINTS).add(k)).assign(start);
        }
      }).Else(() => {
        // Nowhere this time (or not now): tried again next frame.
        heads.element(instanceIndex).assign(vec4(0, 0, 0, 0));
        lives.element(instanceIndex).assign(vec4(0));
      });
    }).Else(() => {
      // Carried on the wind: midpoint steps, paced.
      const p = head.xz;
      const dt = u.delta.mul(life.w);
      const v = flow(p.add(flow(p).mul(dt.mul(0.5))));
      const next = p.add(v.mul(dt)).toVar();
      const y = lifted(next);
      const speed = length(v);
      // Off the map, it's done.
      const left = select(inside(next), age, life.x);

      heads.element(instanceIndex).assign(vec4(next.x, y, next.y, left));
      lives.element(instanceIndex).assign(vec4(life.x, life.y, speed, life.w));

      If(u.record.equal(1), () => {
        trail
          .element(instanceIndex.mul(POINTS).add(uint(u.ring)))
          .assign(vec4(next.x, y, next.y, speed));
      });
    });
  })().compute(count);

  // --- The ribbons. ---

  const k = int(positionGeometry.x);
  const side = positionGeometry.y;
  const ring = int(u.ring);
  const head = heads.element(instanceIndex);
  const life = lives.element(instanceIndex);

  /** The j-th newest record. */
  const record = (j) =>
    trail.element(
      int(instanceIndex).mul(POINTS).add(ring.add(POINTS).sub(j).mod(POINTS))
    );

  /**
   * Point n of the ribbon: the head, the records, and the oldest part of
   * the way to the next, so the tail's as far back each frame.
   */
  const point = (n) =>
    select(
      n.equal(0),
      vec4(head.xyz, life.z),
      select(
        n.lessThan(POINTS),
        record(n.sub(1)),
        mix(record(POINTS - 1), record(POINTS - 2), u.fraction)
      )
    );

  const at = point(k);
  const world = (p) => vec3(p.x, p.y.add(u.lift), p.z);

  const clipOf = (p) =>
    cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(world(p), 1));

  const here = clipOf(at);
  const ahead = clipOf(point(select(k.greaterThan(0), k.sub(1), int(0))));

  const behind = clipOf(
    point(select(k.lessThan(POINTS), k.add(1), int(POINTS)))
  );

  const pixels = (clip) =>
    clip.xy.div(max(clip.w.abs(), 1e-4)).mul(screenSize).mul(0.5);

  const along = pixels(ahead).sub(pixels(behind));
  const direction = along.div(max(length(along), 1e-6));
  const normal = vec2(direction.y.negate(), direction.x);

  const offset = normal
    .mul(side.mul(u.halfWidth))
    .div(screenSize.mul(0.5))
    .mul(here.w);

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  material.fog = false;
  material.vertexNode = vec4(here.xy.add(offset), here.zw);

  // 0 at the head, 1 at the tail, in time.
  const back = select(
    k.equal(0),
    float(0),
    float(k.sub(1))
      .add(u.fraction)
      .div(POINTS - 1)
  ).min(1);

  const age = head.w;
  const distance = length(world(at).sub(u.eye));

  const strength = varying(
    life.y
      .mul(smoothstep(0, FADE_IN, age))
      .mul(smoothstep(life.x, life.x.sub(FADE_OUT), age))
      .mul(mix(0.3, 1, smoothstep(CALM, GALE, at.w)))
      .mul(float(1).sub(smoothstep(u.fadeFrom, u.reach, distance)))
      .mul(smoothstep(u.near.mul(0.5), u.near, distance))
      .mul(float(1).sub(smoothstep(BLURRED, BLOTTED, lensBlur(here.w))))
      .mul(hazeTransmittance(u.eye, world(at)))
  );

  const tail = varying(back);
  const across = varying(side);

  material.colorNode = vec3(u.dim.mul(0.9));
  material.opacityNode = strength
    .mul(OPACITY)
    .mul(pow(float(1).sub(tail), 1.3))
    .mul(float(1).sub(across.mul(across)));

  const geometry = createRibbon();
  geometry.instanceCount = count;

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  // Drawn after the scene's other see-through things: it's on top of them.
  mesh.renderOrder = 10;

  return { mesh, update, uniforms: u, maps };
}

function isWebGPU(renderer: WebGPURenderer) {
  return (
    "isWebGPUBackend" in renderer.backend &&
    renderer.backend.isWebGPUBackend === true
  );
}

/** Runs before the frame's drawn, after the camera's moved (0.5). */
const WIND_PRIORITY = 0.7;

const target = new Vector3();

/**
 * Trails of the surface wind, `wind` blowing (speed m/s, direction from),
 * over the ground `cache` holds. Needs WebGPU's compute shaders.
 *
 * Switched off (`on` false), no more are born and those there are fade at
 * the end of their lives; `onFaded` is called once they all have.
 */
export function Wind({
  index,
  cache,
  wind,
  night,
  quality,
  on = true,
  onFaded,
}: {
  index: TileIndex;
  cache: TileCache;
  wind: { speed: number; direction: number };
  /** 0 by day, 1 at night: dimmer then. */
  night: number;
  quality: WindQuality;
  on?: boolean;
  onFaded?: () => void;
}) {
  const renderer = useRenderer();
  const supported = isWebGPU(renderer);
  const controls = useThree((state) => state.controls);
  const [field, setField] = useState<WindField | null>(null);

  useEffect(() => {
    if (!supported) return;
    let stopped = false;

    loadWindField().then(
      (loaded) => !stopped && setField(loaded),
      (e) => console.error("[wind]", e)
    );

    return () => {
      stopped = true;
    };
  }, [supported]);

  const lookup = useMemo(() => new GroundLookup(index), [index]);

  useEffect(() => () => lookup.dispose(), [lookup]);

  const built = useMemo(
    () => (field ? build(quality.trails, field, index, cache, lookup) : null),
    [field, quality.trails, index, cache, lookup]
  );

  useEffect(
    () => () => {
      built?.mesh.geometry.dispose();
      built?.mesh.material.dispose();
      built?.maps.flow.dispose();
      built?.maps.land.dispose();
    },
    [built]
  );

  const progress = useRef<{
    for: ReturnType<typeof build> | null;
    compiled: Promise<void> | null;
    ready: boolean;
    distance: number;
    since: number;
    ring: number;
    frame: number;
  } | null>(null);

  // Where the wind's easing to; set straight away when first built.
  const blowing = useRef(new Vector2());

  useEffect(() => {
    const [wx, wz] = windVector(wind.speed, wind.direction);
    blowing.current.set(wx, wz);
  }, [wind.speed, wind.direction]);

  useEffect(() => {
    built?.uniforms.wind.value.copy(blowing.current);
  }, [built]);

  useEffect(() => {
    if (built) built.uniforms.dim.value = 1 - 0.65 * night;
  }, [built, night]);

  // How long it's been off, s.
  const off = useRef(0);

  useFrame(({ camera, gl }, frameDelta) => {
    off.current = on ? 0 : off.current + frameDelta;

    // Nothing's shown yet, or everything's lived out its life.
    if (
      !on &&
      (!built || !progress.current?.ready || off.current > LIFE + SPREAD)
    ) {
      onFaded?.();

      return;
    }

    if (!built) return;

    if (progress.current?.for !== built) {
      progress.current = {
        for: built,
        compiled: null,
        ready: false,
        distance: 0,
        since: 0,
        ring: 0,
        frame: 0,
      };
    }

    const state = progress.current;

    if (!state.ready) {
      state.compiled ??= renderer.compileComputeAsync(built.update).then(() => {
        state.ready = true;
      });

      return;
    }

    const u = built.uniforms;
    const delta = Math.min(frameDelta, 0.1);

    u.wind.value.lerp(blowing.current, 1 - Math.exp(-delta / WIND_EASE));

    u.spawning.value = on ? 1 : 0;

    lookup.update(cache);

    // How far the camera is from what it's looking at.
    let distance = 2000;

    if (orbits(controls)) {
      controls.getTarget(target);
      distance = Math.max(camera.position.distanceTo(target), 50);
    } else {
      camera.getWorldDirection(target).multiplyScalar(distance);
      target.add(camera.position);
    }

    state.distance =
      state.distance === 0
        ? distance
        : state.distance +
          (distance - state.distance) * (1 - Math.exp(-delta / VIEW_EASE));

    // Gusts drift at the pace of the trails born where it's looking.
    const pace = Math.max(Math.sqrt(state.distance / PACE_DISTANCE), 1);

    // The camera's height above the ground.
    const under = cache.heightAt(camera.position.x, camera.position.z) ?? 0;

    const eye = Math.max(
      camera.position.y - Math.max(under, 0) * verticalScale.value,
      1
    );

    u.delta.value = delta;
    u.reach.value = Math.min(state.distance * BIRTH_REACH, MAX_REACH);
    u.near.value = Math.max(state.distance * NEAR, 10);
    u.fadeFrom.value = Math.min(state.distance * FADE_FROM, MAX_REACH * 0.6);

    // Always under the camera: level with it, they'd all be seen edge on,
    // in one bright line across the view.
    u.lift.value = Math.min(
      Math.max(state.distance * LIFT, LIFT_RANGE[0]),
      LIFT_RANGE[1],
      eye * EYE_LIFT
    );

    u.landLift.value = Math.min(LAND_LIFT, eye * EYE_LAND_LIFT);
    u.halfWidth.value = (WIDTH * gl.getPixelRatio()) / 2;
    u.eye.value.copy(camera.position);
    u.worldFromClip.value.multiplyMatrices(
      camera.matrixWorld,
      camera.projectionMatrixInverse
    );

    const { x: wx, y: wz } = u.wind.value;
    u.gustOffset.value.x += wx * delta * pace;
    u.gustOffset.value.y += wz * delta * pace;
    u.gustTime.value += (delta * pace) / GUST_CHANGE;

    // A record every STEP: the trails' length in time whatever the frame
    // rate.
    state.since += delta;
    u.record.value = 0;

    if (state.since >= STEP) {
      state.since = Math.min(state.since - STEP, STEP);
      state.ring = (state.ring + 1) % POINTS;
      u.record.value = 1;
    }

    u.ring.value = state.ring;
    u.fraction.value = state.since / STEP;
    u.frame.value = state.frame++ % 1_000_000;

    renderer.compute(built.update);
  }, WIND_PRIORITY);

  if (!built) return null;

  return <primitive object={built.mesh} />;
}
