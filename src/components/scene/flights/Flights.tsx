import { RefObject, useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Euler,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  Matrix4,
  MeshStandardNodeMaterial,
  NormalBlending,
  Quaternion,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
} from "three/webgpu";
import {
  attribute,
  cameraPosition,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  max,
  positionGeometry,
  select,
  smoothstep,
  sqrt,
  step,
  time,
  uniform,
  uv,
  varying,
} from "three/tsl";
import { LineSegments2 } from "three/examples/jsm/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import type { HeightQuery } from "../terrain/Terrain";
import { hazeTransmittance } from "../haze";
import { TrailMaterial } from "../trailMaterial";
import { pixelAngle, random } from "../landmarks/common";
import { Fix } from "../../../lib/flights";
import { Airframe, airframeFor, Shape } from "./airframes";
import {
  Axis,
  BLADE,
  createHelicopterGeometry,
  createJetGeometry,
  createPropGeometry,
  createRotorGeometry,
  JET_WING_RISE,
  RIDE_HEIGHT,
  Rotor,
  ROTORS,
} from "./geometry";
import { createModelMaterial, HIDDEN, isNear, NearModels } from "../models/lod";
import {
  buildPath,
  EXTRAPOLATE,
  Path,
  pointBefore,
  Pose,
  poseAt,
} from "./path";
import { createClearance } from "./clearance";
import { extend } from "./route";
import { HOME, landing, runwayInUse, takingOff } from "./runway";
import { Aircraft, useFlights } from "./useFlights";
import {
  Candidate,
  followed,
  publish,
  useFollowCandidates,
  useFollowSpots,
} from "../follow/store";

const SHAPES: Shape[] = ["jet", "prop", "helicopter"];
const MAX_PER_SHAPE = 64;

/**
 * Planes are drawn this far behind live, ms, so there's nearly always a fix
 * ahead of them to fly towards rather than guessing. Polls are 10s apart
 * and the edge cache can add another 10s, or 20s served stale.
 */
const DELAY = 30_000;

/** The time drawn now, s since `epoch`, on the feed's clock. */
const drawnTime = (skew: number, epoch: number) =>
  (Date.now() - skew - DELAY - epoch) / 1000;

/**
 * Never shorter on screen than this many pixels. Real size, a regional
 * turboprop is a pixel or two from across the harbour.
 */
const MIN_PIXELS = 10;

/** Detailed models, each way an aircraft can look up close. */
type Detailed = "jet" | "jetGear" | "prop" | "propGear" | "helicopter";

/** Of each detailed model at once. */
const MAX_DETAILED = 8;

/** Gear's down below this, m above the ground: on short final, and climbing out. */
const GEAR_DOWN = 400;

/** Slower than this on the ground, m/s, an aircraft's props or rotors stop. */
const PARKED = 1;

/** Seconds for rotors to spin up, or run down once parked. */
const SPIN_UP = 4;

/**
 * Most of the gap between blades they turn in a frame. Past half, they'd
 * look to turn backward, as wheels in films; real props are far faster.
 */
const MAX_STEP = 1 / 3;

/** Each engine's prop is this far round from the last's, radians. */
const HUB_STAGGER = 0.4;

/** A turning rotor's blur, up close, at full speed. */
const DISC_OPACITY = 0.2;

/**
 * Wellington's yellow, against the scene's greys: it's data, not part of the
 * view.
 */
const TRAIL_COLOR = new Color(1, 0.8, 0.1);

/** Where a plane has been. */
const BEHIND_OPACITY = 0.35;

/** Where it's going: what's known, then the way to its destination. */
const AHEAD_OPACITY = 0.14;

/** Pixels. */
const TRAIL_WIDTH = 2;
const MAX_TRAIL_SEGMENTS = 40_000;

/** Ahead of a plane, its trail is dashed: dash and gap lengths, metres. */
const DASH = 120;
const GAP = 200;

/**
 * Behind a plane, its trail is whole for this many seconds, then fades out
 * over the next TAIL_FADE, the oldest first.
 */
const TAIL_HOLD = 20;
const TAIL_FADE = 40;

/**
 * The way on goes with its aircraft, which is drawn for EXTRAPOLATE seconds
 * past its last fix in the air: coming in to land, it's often lost close to
 * the ground. It fades out over the last FADE_OUT.
 */
const FADE_OUT = 10;

/** Slowest an aircraft is taken to have flown in from its origin, m/s. */
const MIN_INBOUND_SPEED = 50;

/** On the ground this close to an airport, metres, it's at it. */
const AT_AIRPORT = 5000;

/** Without a route, a trail fades in over this distance, metres. */
const FADE_IN = 3000;

/** Fades out between these distances from the camera, metres (far is 80 km). */
const TRAIL_FAR: [number, number] = [35_000, 75_000];

/** Time of a route's way on, seconds: always ahead. */
const FUTURE = 1e9;

/** Cruising altitudes, metres, for drawing routes off the map. */
const CRUISE: Record<Shape, number> = {
  jet: 10_500,
  prop: 7000,
  helicopter: 1000,
};

/** Faster than this, m/s, on the ground, an aircraft is worth following. */
const TAXIING = 3;

/** Seconds apart that a followed aircraft's speed is sampled. */
const SAMPLE = 1;

/** Landing lights are on below this, metres above the ground (10,000 ft). */
const LANDING_LIGHTS_BELOW = 3000;

/** Anti-collision beacon flashes per second. */
const BEACON_RATE = 1;

/** Seconds between strobe double-flashes. */
const STROBE_PERIOD = 1.2;

/** Smallest light, metres; most are bigger on screen, see `minPixels`. */
const LIGHT_SIZE = 3;

const RED = new Color(1, 0.07, 0.03);
const GREEN = new Color(0.1, 1, 0.35);
const WHITE = new Color(1, 1, 1);
const LANDING = new Color(1, 0.94, 0.82);

enum Pattern {
  Steady = 0,
  Beacon = 1,
  Strobe = 2,
}

interface LightSpec {
  /** Unit-aircraft position: x starboard, y up, z aft. */
  at: [number, number, number];
  color: Color;
  pattern: Pattern;
  minPixels: number;
  landing?: boolean;
}

function lightsFor(
  span: number,
  wingY: number,
  wingZ: number,
  beacon: [number, number, number],
  landing: [number, number, number],
  /** Wingtips above wingY. */
  rise = 0
): LightSpec[] {
  const tip = (side: number): [number, number, number] => [
    side * span,
    wingY + rise,
    wingZ,
  ];

  return [
    { at: beacon, color: RED, pattern: Pattern.Beacon, minPixels: 9 },
    { at: tip(-1), color: RED, pattern: Pattern.Steady, minPixels: 6 },
    { at: tip(1), color: GREEN, pattern: Pattern.Steady, minPixels: 6 },
    {
      at: [0, wingY + 0.04, 0.5],
      color: WHITE,
      pattern: Pattern.Steady,
      minPixels: 5,
    },
    { at: tip(-1.02), color: WHITE, pattern: Pattern.Strobe, minPixels: 12 },
    { at: tip(1.02), color: WHITE, pattern: Pattern.Strobe, minPixels: 12 },
    {
      at: landing,
      color: LANDING,
      pattern: Pattern.Steady,
      minPixels: 22,
      landing: true,
    },
  ];
}

/** Where each shape's lights are, matching geometry.ts. */
const LIGHTS: Record<Shape, LightSpec[]> = {
  jet: lightsFor(
    0.475,
    -0.03,
    0.15,
    [0, 0.055, 0],
    [0, -0.04, -0.3],
    JET_WING_RISE
  ),
  prop: lightsFor(0.55, 0.05, -0.06, [0, 0.215, 0.45], [0, 0.0, -0.35]),
  helicopter: lightsFor(0.1, 0, -0.1, [0, 0.13, 0.1], [0, -0.1, -0.38]),
};

const LIGHTS_PER_AIRCRAFT = 7;
const MAX_LIGHTS = SHAPES.length * MAX_PER_SHAPE * LIGHTS_PER_AIRCRAFT;

/** Seconds since the page's epoch, where trails are now. */
const trailNow = uniform(0);

function createPlanes() {
  const { material, lit } = createModelMaterial({
    roughness: 0.45,
    metalness: 0.1,
  });

  const simple = (shape: Shape, geometry: BufferGeometry) => {
    const mesh = new InstancedMesh(geometry, material, MAX_PER_SHAPE);
    mesh.name = shape;
    // Instances move every frame; their bounds would always be stale.
    mesh.frustumCulled = false;
    mesh.count = 0;

    return mesh;
  };

  const far: Record<Shape, InstancedMesh> = {
    jet: simple("jet", createJetGeometry()),
    prop: simple("prop", createPropGeometry()),
    helicopter: simple("helicopter", createHelicopterGeometry()),
  };

  const detailed = (geometry: BufferGeometry) =>
    new NearModels(geometry, material, MAX_DETAILED);

  const near: Record<Detailed, NearModels> = {
    jet: detailed(createJetGeometry(true)),
    jetGear: detailed(createJetGeometry(true, { gear: true })),
    prop: detailed(createPropGeometry(true)),
    propGear: detailed(createPropGeometry(true, { gear: true })),
    helicopter: detailed(createHelicopterGeometry(true)),
  };

  const turning = (rotor: Rotor, detailed: boolean, capacity: number) => {
    const models = new NearModels(
      createRotorGeometry(rotor, detailed),
      material,
      capacity * rotor.hubs.length
    );

    // Its shadow would strobe at the near map's pace.
    models.mesh.castShadow = false;

    return models;
  };

  // Up close, a shape's in either of two detailed models.
  const spinning = (rotor: Rotor) => ({
    near: turning(rotor, true, 2 * MAX_DETAILED),
    far: rotor.far ? turning(rotor, false, MAX_PER_SHAPE) : null,
  });

  const rotors: Record<Shape, ReturnType<typeof spinning>[]> = {
    jet: ROTORS.jet.map(spinning),
    prop: ROTORS.prop.map(spinning),
    helicopter: ROTORS.helicopter.map(spinning),
  };

  const blurs = SHAPES.flatMap((shape) =>
    rotors[shape].map(({ near }) => near.capacity)
  ).reduce((sum, n) => sum + n, 0);

  return { far, near, rotors, discs: createDiscs(blurs), material, lit };
}

/** The blur of a turning rotor's blades, as a faint disc. */
function createDiscs(capacity: number) {
  const opacity = new InstancedBufferAttribute(new Float32Array(capacity), 1);

  const material = new MeshStandardNodeMaterial({
    color: BLADE,
    roughness: 0.6,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  material.opacityNode = instancedBufferAttribute<"float">(opacity, "float");

  const mesh = new InstancedMesh(new CircleGeometry(1, 32), material, capacity);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.visible = false;

  return { mesh, opacity, capacity };
}

/** Which detailed model an aircraft is, up close. */
function detailedFor(shape: Shape, at: Pose): Detailed {
  if (shape === "helicopter") return shape;
  const gear = at.ground || at.height < GEAR_DOWN;

  if (!gear) return shape;

  return shape === "jet" ? "jetGear" : "propGear";
}

/** How an aircraft's rotors are turning. */
interface Spin {
  /** 0, stopped, to 1, at speed. */
  speed: number;
  /** Each rotor's angle, radians. */
  angles: number[];
}

/** Turns rotors on by `dt`, s: spinning up, or running down when parked. */
function turn(spin: Spin, rotors: Rotor[], running: boolean, dt: number) {
  spin.speed +=
    ((running ? 1 : 0) - spin.speed) * (1 - Math.exp(-dt / SPIN_UP));

  rotors.forEach((rotor, i) => {
    const gap = (2 * Math.PI) / rotor.blades;

    const step = Math.min(
      Math.abs(rotor.rate) * 2 * Math.PI * spin.speed * dt,
      gap * MAX_STEP
    );

    spin.angles[i] = (spin.angles[i] + Math.sign(rotor.rate) * step) % gap;
  });
}

/** Turns blades built round z to stand along each axis. */
const SHAFT: Record<Axis, Quaternion> = {
  x: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2),
  y: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2),
  z: new Quaternion(),
};

/**
 * Every trail as one set of fat line segments. Each end carries its time, so
 * the shader can tell what's behind a plane (solid) from what's ahead of it
 * (dashed), a weight, and its distance along the trail, for the dashes; each
 * segment, when its trail is gone.
 */
function createTrails() {
  const geometry = new LineSegmentsGeometry();

  const segments = new InstancedInterleavedBuffer(
    new Float32Array(MAX_TRAIL_SEGMENTS * 6),
    6,
    1
  );

  geometry.setAttribute(
    "instanceStart",
    new InterleavedBufferAttribute(segments, 3, 0)
  );
  geometry.setAttribute(
    "instanceEnd",
    new InterleavedBufferAttribute(segments, 3, 3)
  );

  const times = new InstancedInterleavedBuffer(
    new Float32Array(MAX_TRAIL_SEGMENTS * 7),
    7,
    1
  );

  geometry.setAttribute(
    "instanceTimeStart",
    new InterleavedBufferAttribute(times, 1, 0)
  );
  geometry.setAttribute(
    "instanceTimeEnd",
    new InterleavedBufferAttribute(times, 1, 1)
  );
  geometry.setAttribute(
    "instanceWeightStart",
    new InterleavedBufferAttribute(times, 1, 2)
  );
  geometry.setAttribute(
    "instanceWeightEnd",
    new InterleavedBufferAttribute(times, 1, 3)
  );
  geometry.setAttribute(
    "instanceUntil",
    new InterleavedBufferAttribute(times, 1, 4)
  );
  geometry.setAttribute(
    "instanceDistanceStart",
    new InterleavedBufferAttribute(times, 1, 5)
  );
  geometry.setAttribute(
    "instanceDistanceEnd",
    new InterleavedBufferAttribute(times, 1, 6)
  );
  geometry.instanceCount = 0;

  const material = new TrailMaterial({
    color: TRAIL_COLOR,
    linewidth: TRAIL_WIDTH,
    worldUnits: false,
    transparent: true,
    depthWrite: false,
  });

  material.blending = NormalBlending;
  material.alphaToCoverage = false;
  // Its fog would be the template quad's, not the line's: hazed below.
  material.fog = false;

  // The template quad's y is below 0.5 at a segment's start, above at its end.
  const end = <T extends "float" | "vec3">(
    type: T,
    start: string,
    end: string
  ) =>
    select(
      positionGeometry.y.lessThan(0.5),
      attribute<T>(start, type),
      attribute<T>(end, type)
    );

  const at = varying(end("float", "instanceTimeStart", "instanceTimeEnd"));

  const weight = varying(
    end("float", "instanceWeightStart", "instanceWeightEnd")
  );

  const until = varying(attribute<"float">("instanceUntil", "float"));

  const along = varying(
    end("float", "instanceDistanceStart", "instanceDistanceEnd")
  );

  const dash = step(fract(along.div(DASH + GAP)), float(DASH / (DASH + GAP)));
  const where = end("vec3", "instanceStart", "instanceEnd");

  const seen = varying(
    hazeTransmittance(cameraPosition, where).mul(
      float(1).sub(smoothstep(...TRAIL_FAR, cameraPosition.distance(where)))
    )
  );

  const age = trailNow.sub(at);
  const tail = float(1).sub(smoothstep(TAIL_HOLD, TAIL_HOLD + TAIL_FADE, age));
  const linger = until.sub(trailNow).div(FADE_OUT).clamp(0, 1);
  material.opacityNode = select(
    age.lessThan(0),
    dash.mul(AHEAD_OPACITY).mul(linger),
    float(BEHIND_OPACITY).mul(tail)
  )
    .mul(weight)
    .mul(seen);

  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  // After the sea (1) and wakes (2).
  lines.renderOrder = 3;

  return { lines, segments, times };
}

/** Navigation, anti-collision and landing lights, as glowing sprites. */
function createLights() {
  const light = new InstancedBufferAttribute(
    new Float32Array(MAX_LIGHTS * 4),
    4
  );

  const style = new InstancedBufferAttribute(
    new Float32Array(MAX_LIGHTS * 4),
    4
  );

  const extra = new InstancedBufferAttribute(
    new Float32Array(MAX_LIGHTS * 2),
    2
  );

  const at = instancedBufferAttribute<"vec4">(light, "vec4");
  const look = instancedBufferAttribute<"vec4">(style, "vec4");
  const more = instancedBufferAttribute<"vec2">(extra, "vec2");
  const position = at.xyz;

  const material = new SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  material.fog = false;
  material.positionNode = position;
  const distance = cameraPosition.distance(position);
  material.scaleNode = max(
    float(LIGHT_SIZE),
    distance.mul(pixelAngle).mul(more.y)
  );

  const beat = fract(time.mul(BEACON_RATE).add(more.x));

  const beacon = smoothstep(0, 0.03, beat).mul(
    float(1).sub(smoothstep(0.1, 0.2, beat))
  );

  const blink = fract(time.div(STROBE_PERIOD).add(more.x));

  const pulse = (start: number) =>
    smoothstep(start, start + 0.01, blink).mul(
      float(1).sub(smoothstep(start + 0.03, start + 0.05, blink))
    );

  const strobe = pulse(0).add(pulse(0.12));

  const on = select(
    look.w.lessThan(0.5),
    float(1),
    select(look.w.lessThan(1.5), beacon, strobe)
  );

  const r = uv().sub(0.5).length().mul(2);
  // A hot core in a soft halo, as the obstruction lights.
  const glow = exp(r.mul(r).mul(-40)).add(exp(r.mul(-4.5)).mul(0.4));
  const edge = float(1).sub(smoothstep(0.85, 1, r));
  material.colorNode = look.xyz
    .mul(glow.mul(edge).mul(on).mul(at.w).mul(3))
    .mul(sqrt(hazeTransmittance(cameraPosition, position)));

  const sprite = new Sprite(material);
  sprite.count = 0;
  sprite.frustumCulled = false;
  sprite.renderOrder = 10;

  return { sprite, light, style, extra };
}

/** Every rotor's blades, near and far. */
function spinningModels({ rotors }: ReturnType<typeof createPlanes>) {
  return SHAPES.flatMap((shape) =>
    rotors[shape].flatMap(({ near, far }) => (far ? [near, far] : [near]))
  );
}

interface Plane {
  aircraft: Aircraft;
  airframe: Airframe;
  path: Path;
  /** Instance within its shape's simple mesh. */
  slot: number;
  /** 0..1, so beacons and strobes don't flash in unison. */
  phase: number;
  /** How far through lighting-up its crew switch the lights on, 0..1. */
  switchOn: number;
}

/**
 * What of a path to draw as a trail: its points up to `last`, the latest fix
 * (past that is only dead reckoning), and until when its way on is drawn,
 * seconds since `epoch`.
 * Null if it's not been seen off the ground.
 */
function trailOf(aircraft: Aircraft, path: Path, epoch: number) {
  const { fixes } = aircraft;
  let airborne = fixes.length - 1;

  while (airborne >= 0 && fixes[airborne][2] === null) airborne--;

  if (airborne < 0) return null;
  const time = (fix: Fix) => (fix[3] - epoch) / 1000;

  return {
    last: pointBefore(path, time(fixes[fixes.length - 1])),
    // As long as it's drawn in the air.
    until: time(fixes[airborne]) + EXTRAPOLATE,
  };
}

/**
 * Which of its route a trail is drawn along: back to where it came from, on
 * to where it's going. A route is for its callsign's flight, and crews put
 * in the next flight's at the gate. Once it's been seen taking off, the way
 * it came was another flight; before that, coming in to or sitting at where
 * its route starts, the route is all the next one's.
 */
function routeUse({ fixes, route }: Aircraft) {
  if (!route) return { back: false, on: false };

  const tookOff = fixes.some(
    (fix, i) => i > 0 && fixes[i - 1][2] === null && fix[2] !== null
  );

  if (tookOff) return { back: false, on: true };
  const [e, n] = route.from.at;
  const away = (fix: Fix) => Math.hypot(fix[0] - e, fix[1] - n);
  const last = fixes[fixes.length - 1];

  const next =
    route.from.elevation !== null &&
    (last[2] === null ? away(last) < AT_AIRPORT : away(last) < away(fixes[0]));

  return { back: !next, on: !next };
}

const matrix = new Matrix4();
const rotation = new Quaternion();
const euler = new Euler(0, 0, 0, "YXZ");
const scale = new Vector3();
const position = new Vector3();
const offset = new Vector3();
const forward = new Vector3();
const toCamera = new Vector3();
const part = new Matrix4();
const hub = new Vector3();
const spun = new Quaternion();
const ONE = new Vector3(1, 1, 1);
const Z = new Vector3(0, 0, 1);

const pose: Pose = {
  x: 0,
  y: 0,
  z: 0,
  heading: 0,
  pitch: 0,
  bank: 0,
  ground: false,
  height: 0,
};

const probe: Pose = { ...pose };
const before: Pose = { ...pose };
const earlier: Pose = { ...pose };

/** A followed aircraft's speed and climb, m/s, and gain in speed, m/s². */
function motionAt(path: Path, now: number, at: Pose) {
  const speedBetween = (a: Pose, b: Pose) =>
    Math.hypot(b.x - a.x, b.z - a.z) / SAMPLE;

  if (!poseAt(path, now - SAMPLE, before)) {
    return { speed: 0, climb: 0, accel: 0 };
  }

  const speed = speedBetween(before, at);

  const accel = poseAt(path, now - 2 * SAMPLE, earlier)
    ? (speed - speedBetween(earlier, before)) / SAMPLE
    : 0;

  return { speed, climb: (at.y - before.y) / SAMPLE, accel };
}

/** What a flight's called, and where it's going if that's known. */
function labelFor({ callsign, registration, hex, route }: Aircraft) {
  const name = callsign?.trim() || registration || hex.toUpperCase();

  return route ? `${name} · ${route.from.code} → ${route.to.code}` : name;
}

/**
 * Aircraft around Wellington at their live ADS-B positions, a little behind
 * real time, with trails of where they've been in the last minute
 * and, fainter still, where they're going.
 * `lights` (0..1), how far through lighting-up, turns on their navigation
 * lights plane by plane, for night. `windFrom` (degrees) picks the runway
 * when no traffic shows which way it's in use.
 */
export function Flights({
  index,
  heightAt,
  lights = 0,
  windFrom,
}: {
  index: TileIndex;
  heightAt: RefObject<HeightQuery | null>;
  lights?: number;
  windFrom: number;
}) {
  const { aircraft, skew } = useFlights();
  const epoch = useMemo(() => Date.now(), []);
  const planes = useMemo(createPlanes, []);
  const trails = useMemo(createTrails, []);
  const sprites = useMemo(createLights, []);
  const spots = useFollowSpots("plane");
  const spins = useMemo(() => new Map<string, Spin>(), []);

  const { toWorld, groundAt } = useMemo(
    () => ({
      toWorld: (e: number, n: number) => nztmToWorld(index.manifest, e, n),
      groundAt: (x: number, z: number) =>
        Math.max(heightAt.current?.(x, z) ?? 0, 0),
    }),
    [index, heightAt]
  );

  const clearance = useMemo(() => createClearance(toWorld), [toWorld]);

  const flying = useMemo(() => {
    const counts: Record<Shape, number> = { jet: 0, prop: 0, helicopter: 0 };

    return aircraft.flatMap((a): Plane[] => {
      const airframe = airframeFor(a);

      if (counts[airframe.shape] >= MAX_PER_SHAPE) return [];

      return [
        {
          aircraft: a,
          airframe,
          path: buildPath(a.fixes, epoch, toWorld, groundAt, (x, z, heading) =>
            clearance(x, z, heading, airframe.length)
          ),
          slot: counts[airframe.shape]++,
          phase: random(parseInt(a.hex, 16) || 0),
          switchOn: random((parseInt(a.hex, 16) || 0) + 1),
        },
      ];
    });
  }, [aircraft, toWorld, groundAt, clearance, epoch]);

  useFollowCandidates(
    "plane",
    useMemo(
      () =>
        flying.map(({ aircraft, path }): Candidate => {
          const last = aircraft.fixes[aircraft.fixes.length - 1];

          return {
            id: aircraft.hex,
            label: labelFor(aircraft),
            moving: last[2] !== null || last[4] > TAXIING,
            // Known from the feed but not yet, or no longer, flown.
            drawn: () => poseAt(path, drawnTime(skew, epoch), probe),
          };
        }),
      [flying, skew, epoch]
    )
  );

  useEffect(() => {
    planes.lit.value = lights;
  }, [planes, lights]);

  useEffect(() => {
    const present = new Set(flying.map(({ aircraft }) => aircraft.hex));

    for (const hex of spins.keys()) if (!present.has(hex)) spins.delete(hex);
  }, [flying, spins]);

  useEffect(() => {
    for (const shape of SHAPES) planes.far[shape].count = 0;

    for (const { airframe, slot } of flying) {
      const mesh = planes.far[airframe.shape];
      mesh.count = Math.max(mesh.count, slot + 1);
    }

    const { lines, segments, times } = trails;
    const positions = segments.array;
    const stamps = times.array;
    let n = 0;
    /** Distance along the current trail, metres. */
    let along = 0;

    const add = (
      a: ArrayLike<number>,
      b: ArrayLike<number>,
      [ta, tb]: [number, number],
      [wa, wb]: [number, number],
      until: number
    ) => {
      if (n >= MAX_TRAIL_SEGMENTS) return;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      positions.set([a[0], a[1], a[2], b[0], b[1], b[2]], n * 6);
      stamps.set([ta, tb, wa, wb, until, along, along + length], n * 7);
      along += length;
      n++;
    };

    const line = (
      points: ArrayLike<number>[],
      time: (i: number) => number,
      until: number
    ) => {
      for (let i = 0; i < points.length - 1; i++) {
        add(points[i], points[i + 1], [time(i), time(i + 1)], [1, 1], until);
      }
    };

    const direction = runwayInUse(
      flying.map(({ aircraft }) => aircraft.fixes),
      windFrom
    );

    const arriving = landing(direction, toWorld);
    const departing = takingOff(direction, toWorld);

    for (const { aircraft, airframe, path } of flying) {
      const trail = trailOf(aircraft, path, epoch);

      if (!trail) continue;
      along = 0;
      const { last, until } = trail;
      const first = 0;
      const point = (i: number) => [path.x[i], path.y[i], path.z[i]];
      const cruise = CRUISE[airframe.shape];
      const { route } = aircraft;
      const use = routeUse(aircraft);

      // Back to where it came from, if it was first seen in the air.
      const before =
        route && use.back && !path.ground[first]
          ? extend(
              {
                x: path.x[first],
                y: path.y[first],
                z: path.z[first],
                heading: path.heading[first] + Math.PI,
                climbing: (aircraft.fixes[0][6] ?? 0) < 0,
              },
              route.from,
              cruise,
              toWorld,
              groundAt,
              route.from.code === HOME ? departing : undefined
            ).reverse()
          : [];

      // Timed as if flown at its first seen speed, so it fades from the
      // far end like the rest of the trail.
      const inbound = Math.max(aircraft.fixes[0][4], MIN_INBOUND_SPEED);
      const earlier = new Float64Array(before.length);

      for (let i = before.length - 2; i >= 0; i--) {
        const [a, b] = [before[i], before[i + 1]];
        earlier[i] =
          earlier[i + 1] +
          Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / inbound;
      }

      line(before, (i) => path.t[first] - earlier[i], until);

      // Where it's been seen, skipping the ground: taxiing would only
      // flicker in the tarmac. Without a way back, it fades in.
      let travelled = before.length || path.ground[first] ? FADE_IN : 0;

      for (let i = first; i < last; i++) {
        if (!path.joined[i] || (path.ground[i] && path.ground[i + 1])) continue;
        const weight = Math.min(travelled / FADE_IN, 1);
        travelled += Math.hypot(
          path.x[i + 1] - path.x[i],
          path.y[i + 1] - path.y[i],
          path.z[i + 1] - path.z[i]
        );
        add(
          point(i),
          point(i + 1),
          [path.t[i], path.t[i + 1]],
          [weight, Math.min(travelled / FADE_IN, 1)],
          until
        );
      }

      // On to where it's going, if it was last seen in the air.
      if (route && use.on && !path.ground[last]) {
        const fix = aircraft.fixes[aircraft.fixes.length - 1];
        line(
          extend(
            {
              x: path.x[last],
              y: path.y[last],
              z: path.z[last],
              heading: path.heading[last],
              climbing: (fix[6] ?? 0) > 0,
            },
            route.to,
            cruise,
            toWorld,
            groundAt,
            route.to.code === HOME ? arriving : undefined
          ),
          () => FUTURE,
          until
        );
      }
    }

    segments.needsUpdate = times.needsUpdate = true;
    lines.geometry.instanceCount = n;
  }, [flying, planes, trails, toWorld, groundAt, epoch, windFrom]);

  useEffect(
    () => () => {
      for (const shape of SHAPES) {
        const mesh = planes.far[shape];
        mesh.geometry.dispose();
        mesh.dispose();
      }

      for (const near of Object.values(planes.near)) near.dispose();

      for (const models of spinningModels(planes)) models.dispose();
      planes.discs.mesh.geometry.dispose();
      planes.discs.mesh.material.dispose();
      planes.discs.mesh.dispose();
      planes.material.dispose();

      trails.lines.geometry.dispose();
      trails.lines.material.dispose();
      sprites.sprite.material.dispose();
    },
    [planes, trails, sprites]
  );

  useFrame(({ camera }, dt) => {
    const now = drawnTime(skew, epoch);
    trailNow.value = now;
    const { light, style, extra } = sprites;
    const discs = planes.discs;
    let lit = 0;
    let blurs = 0;
    const watched = followed("plane");
    spots.begin();

    for (const near of Object.values(planes.near)) near.begin();

    for (const models of spinningModels(planes)) models.begin();

    for (const { aircraft, airframe, path, slot, phase, switchOn } of flying) {
      const mesh = planes.far[airframe.shape];

      if (!poseAt(path, now, pose)) {
        mesh.setMatrixAt(slot, HIDDEN);
        continue;
      }

      // Bigger than life when far off, so it's still a shape, not a speck.
      const distance = camera.position.distanceTo(
        position.set(pose.x, pose.y, pose.z)
      );

      const size = Math.max(
        airframe.length,
        distance * pixelAngle.value * MIN_PIXELS
      );

      // Wheels on the ground as it's drawn now, not as it was when the path
      // was built: finer tiles load after. Airborne fixes on the flare and
      // dead reckoning past the last one can sit at or below the runway,
      // which would sink the fuselage into it.
      const ground = heightAt.current?.(pose.x, pose.z) ?? pose.y - pose.height;

      const wheels = Math.max(ground, 0) + size * RIDE_HEIGHT[airframe.shape];

      position.y = pose.ground ? wheels : Math.max(pose.y, wheels);
      euler.set(pose.pitch, -pose.heading, pose.bank);
      rotation.setFromEuler(euler);
      matrix.compose(position, rotation, scale.setScalar(size));

      const detailed =
        isNear(airframe.length, distance) &&
        planes.near[detailedFor(airframe.shape, pose)].add(matrix);

      mesh.setMatrixAt(slot, detailed ? HIDDEN : matrix);
      const rotors = ROTORS[airframe.shape];

      if (rotors.length) {
        const running =
          !pose.ground || motionAt(path, now, pose).speed >= PARKED;

        let spin = spins.get(aircraft.hex);

        if (!spin) {
          spin = {
            speed: running ? 1 : 0,
            angles: rotors.map((_, i) => (phase + i * 0.37) * 2 * Math.PI),
          };

          spins.set(aircraft.hex, spin);
        }

        turn(spin, rotors, running, dt);

        rotors.forEach((rotor, i) => {
          const models = planes.rotors[airframe.shape][i];
          const into = detailed ? models.near : models.far;

          if (!into) return;
          const blur = DISC_OPACITY * spin.speed ** 2;

          rotor.hubs.forEach((at, j) => {
            hub.set(...at);
            spun.setFromAxisAngle(Z, spin.angles[i] + j * HUB_STAGGER);
            spun.premultiply(SHAFT[rotor.axis]);
            into.add(part.compose(hub, spun, ONE).premultiply(matrix));

            if (!detailed || blur < 0.005 || blurs >= discs.capacity) return;
            part.compose(hub, SHAFT[rotor.axis], scale.setScalar(rotor.radius));
            discs.mesh.setMatrixAt(blurs, part.premultiply(matrix));
            discs.opacity.setX(blurs++, blur);
          });
        });
      }

      spots.add(
        aircraft.hex,
        position.x,
        position.y,
        position.z,
        airframe.length
      );

      if (aircraft.hex === watched) {
        publish({
          x: position.x,
          y: position.y,
          z: position.z,
          heading: pose.heading,
          length: airframe.length,
          ground: pose.ground,
          height: pose.height,
          ...motionAt(path, now, pose),
        });
      }

      // Landing lights are brightest pointed at you.
      forward.set(0, 0, -1).applyQuaternion(rotation);
      toCamera.copy(camera.position).sub(position).normalize();
      const facing = 0.15 + 0.85 * Math.max(forward.dot(toCamera), 0) ** 2;
      const on = lights > switchOn ? 1 : 0;

      const landing =
        !pose.ground && pose.height < LANDING_LIGHTS_BELOW
          ? Math.max(on, 0.5) * facing
          : 0;

      for (const spec of LIGHTS[airframe.shape]) {
        if (lit >= MAX_LIGHTS) break;

        const intensity = spec.landing
          ? landing
          : spec.pattern === Pattern.Strobe
            ? Math.max(on, 0.3)
            : on;

        if (intensity <= 0) continue;
        offset.set(...spec.at).applyMatrix4(matrix);
        light.setXYZW(lit, offset.x, offset.y, offset.z, intensity);
        style.setXYZW(
          lit,
          spec.color.r,
          spec.color.g,
          spec.color.b,
          spec.pattern
        );
        extra.setXY(lit, phase, spec.minPixels);
        lit++;
      }
    }

    for (const shape of SHAPES)
      planes.far[shape].instanceMatrix.needsUpdate = true;

    for (const near of Object.values(planes.near)) near.end();

    for (const models of spinningModels(planes)) models.end();

    if (blurs > 0 || discs.mesh.visible) {
      discs.mesh.instanceMatrix.needsUpdate = discs.opacity.needsUpdate = true;
    }

    discs.mesh.count = blurs;
    discs.mesh.visible = blurs > 0;
    sprites.sprite.count = lit;
    sprites.sprite.visible = lit > 0;
    light.needsUpdate = style.needsUpdate = extra.needsUpdate = true;
  });

  return (
    <>
      <primitive object={planes.far.jet} name="jets" />
      <primitive object={planes.far.prop} name="turboprops" />
      <primitive object={planes.far.helicopter} name="helicopters" />
      {Object.entries(planes.near).map(([name, near]) => (
        <primitive key={name} object={near.mesh} name={`detailed ${name}`} />
      ))}
      {spinningModels(planes).map((models, i) => (
        <primitive key={i} object={models.mesh} name="rotor blades" />
      ))}
      <primitive object={planes.discs.mesh} name="rotor blur" />
      <primitive object={trails.lines} name="flight trails" />
      <primitive object={sprites.sprite} name="aircraft lights" />
    </>
  );
}
