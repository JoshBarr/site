import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  Color,
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
  instancedBufferAttribute,
  max,
  positionGeometry,
  select,
  smoothstep,
  sqrt,
  step,
  uniform,
  uniformArray,
  uv,
  varying,
  vec3,
} from "three/tsl";
import { LineSegments2 } from "three/examples/jsm/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { TileIndex } from "../terrain/manifest";
import { pixelAngle } from "../landmarks/common";
import { castsNearShadow } from "../landmarks/nearShadow";
import { hazeTransmittance } from "../haze";
import { TrailMaterial } from "../trailMaterial";
import { createCarGeometry, ROOF, WINDOWS, BODY } from "./geometry";
import { Point, RAIL_TOP, RailNetwork } from "./network";
import { distanceAt, follow, GAP, isPeak, pointAt, Routes, Run } from "./run";
import { useTrains } from "./useTrains";
import type { Line } from "../../../lib/trains";
import {
  Candidate,
  followed,
  publish,
  useFollowCandidates,
} from "../follow/store";

const MAX_TRAINS = 64;
const MAX_CARS = MAX_TRAINS * 8;

/**
 * Trains are drawn this far behind live, ms, so there's nearly always a
 * fix ahead of them to run to: they report about every 30 seconds, and the
 * fix takes a while to reach the page.
 */
const DELAY = 45_000;

/**
 * Seconds over which a train that's fallen behind (it waited at its last
 * fix for the next) makes the time up, at up to three times the pace.
 */
const CATCH_UP = 10;

/** Light pink-purple, against the scene's greys: it's data, like the others. */
const TRAIL_COLOR = new Color(0.9, 0.62, 1);
const TRAIL_OPACITY = 0.45;

/** Pixels. */
const TRAIL_WIDTH = 2;
const MAX_TRAIL_SEGMENTS = 16384;

/** Above the railhead, m: inside the cars, so it comes out behind them. */
const TRAIL_HEIGHT = 2;

/**
 * Behind a train its trail fades out by age, s: whole at the train, gone
 * this far back.
 */
const TAIL_FADE = 2 * 60;

/** Further than this along the line in its trail, m, a train is moving. */
const MOVING = 100;

const LINE_NAMES: Record<Line, string> = {
  KPL: "Kāpiti Line",
  HVL: "Hutt Valley Line",
  MEL: "Melling Line",
  WRL: "Wairarapa Line",
  JVL: "Johnsonville Line",
};

/** Head and tail lights. */
const MAX_LIGHTS = MAX_TRAINS * 2;
const LIGHT_SIZE = 0.8;
const LIGHT_PIXELS = 7;

/** Above the railhead, m. */
const LIGHT_HEIGHT = 1.2;
const HEAD = new Color(1, 0.95, 0.85);
const TAIL = new Color(1, 0.07, 0.03);

/** Window glow at night. */
const LIT_WINDOWS = new Color(1, 0.88, 0.7);

function createCars() {
  const tints = new InstancedBufferAttribute(new Float32Array(MAX_CARS * 3), 3);
  const windowsLit = uniform(0);
  const part = attribute<"float">("part", "float");

  const isPart = (p: number) =>
    part.greaterThan(p - 0.5).and(part.lessThan(p + 0.5));

  const material = new MeshStandardNodeMaterial({ roughness: 0.55 });
  material.colorNode = select(
    isPart(BODY),
    instancedBufferAttribute<"vec3">(tints, "vec3"),
    select(
      isPart(WINDOWS),
      vec3(0.12),
      select(isPart(ROOF), vec3(0.5), vec3(0.09))
    )
  );
  material.emissiveNode = select(
    isPart(WINDOWS),
    vec3(LIT_WINDOWS.r, LIT_WINDOWS.g, LIT_WINDOWS.b).mul(windowsLit.mul(0.7)),
    vec3(0)
  );
  const mesh = new InstancedMesh(createCarGeometry(), material, MAX_CARS);
  // Instances move every frame; their bounds would always be stale.
  mesh.frustumCulled = false;
  mesh.count = 0;
  castsNearShadow(mesh);

  return { mesh, tints, windowsLit };
}

/**
 * Trails behind runs, each segment's ends with their times and the run
 * it's behind, so it shows only as far as that run has got: `opacity` at
 * it, fading out `fade` seconds back. Shared with the buses.
 */
export function createRunTrails({
  runs,
  segments: maxSegments,
  color,
  opacity,
  width,
  fade,
}: {
  runs: number;
  segments: number;
  color: Color;
  opacity: number;
  width: number;
  fade: number;
}) {
  const playheads = uniformArray<"float">(
    Array.from({ length: runs }, () => 0),
    "float"
  );

  const material = new TrailMaterial({
    color,
    linewidth: width,
    worldUnits: false,
    transparent: true,
    depthWrite: false,
  });

  material.blending = NormalBlending;
  material.alphaToCoverage = false;
  // Its fog would be the template quad's, not the line's: hazed below.
  material.fog = false;

  const geometry = new LineSegmentsGeometry();

  const segments = new InstancedInterleavedBuffer(
    new Float32Array(maxSegments * 6),
    6,
    1
  );

  const times = new InstancedInterleavedBuffer(
    new Float32Array(maxSegments * 2),
    2,
    1
  );

  const owner = new InstancedBufferAttribute(new Float32Array(maxSegments), 1);
  geometry.setAttribute(
    "instanceStart",
    new InterleavedBufferAttribute(segments, 3, 0)
  );
  geometry.setAttribute(
    "instanceEnd",
    new InterleavedBufferAttribute(segments, 3, 3)
  );
  geometry.setAttribute(
    "instanceTimeStart",
    new InterleavedBufferAttribute(times, 1, 0)
  );
  geometry.setAttribute(
    "instanceTimeEnd",
    new InterleavedBufferAttribute(times, 1, 1)
  );
  geometry.setAttribute("instanceTrain", owner);
  geometry.instanceCount = 0;

  // The template quad's y is below 0.5 at a segment's start, above at its end.
  const end = <T extends "float" | "vec3">(
    type: T,
    start: string,
    finish: string
  ) =>
    select(
      positionGeometry.y.lessThan(0.5),
      attribute<T>(start, type),
      attribute<T>(finish, type)
    );

  const at = varying(end("float", "instanceTimeStart", "instanceTimeEnd"));

  const seen = varying(
    hazeTransmittance(
      cameraPosition,
      end("vec3", "instanceStart", "instanceEnd")
    )
  );

  const playhead = varying(
    playheads.element(attribute<"float">("instanceTrain", "float").toInt())
  );

  material.opacityNode = step(at, playhead)
    .mul(float(1).sub(playhead.sub(at).div(fade)).clamp(0, 1))
    .mul(opacity)
    .mul(seen);

  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  // After the sea (1).
  lines.renderOrder = 3;

  return { lines, segments, times, owner, playheads, material };
}

/**
 * Up to `count` head and tail lights, as glowing sprites like the ships'.
 * Shared with the buses.
 */
export function createRunLights(count: number) {
  const light = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
  const tint = new InstancedBufferAttribute(new Float32Array(count * 3), 3);

  const at = instancedBufferAttribute<"vec4">(light, "vec4");
  const position = at.xyz;

  const material = new SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  material.fog = false;
  material.positionNode = position;
  material.scaleNode = max(
    float(LIGHT_SIZE),
    cameraPosition.distance(position).mul(pixelAngle).mul(LIGHT_PIXELS)
  );
  const r = uv().sub(0.5).length().mul(2);
  const glow = exp(r.mul(r).mul(-40)).add(exp(r.mul(-4.5)).mul(0.4));
  const edge = float(1).sub(smoothstep(0.85, 1, r));
  material.colorNode = instancedBufferAttribute<"vec3">(tint, "vec3")
    .mul(glow.mul(edge).mul(at.w).mul(3))
    .mul(sqrt(hazeTransmittance(cameraPosition, position)));

  const sprite = new Sprite(material);
  sprite.count = 0;
  sprite.frustumCulled = false;
  sprite.renderOrder = 10;

  return { sprite, light, tint };
}

const matrix = new Matrix4();
const rotation = new Quaternion();
const scale = new Vector3();
const front = new Vector3();
const back = new Vector3();
const centre = new Vector3();
const along = new Vector3();
const FORWARD = new Vector3(0, 0, 1);
const nose = new Vector3();
const tail = new Vector3();
const color = new Color();

/**
 * Metlink's trains at their live positions, run along the tracks from fix
 * to fix a little behind live, with trails behind them. Each one's cars
 * follow the curves. `lights` (0..1), how far through lighting-up, lights
 * their windows and head and tail lights, for night.
 */
export function Trains({
  index,
  network,
  lights = 0,
}: {
  index: TileIndex;
  network: RailNetwork;
  lights?: number;
}) {
  const trains = useTrains();
  const epoch = useMemo(() => Date.now(), []);
  const cars = useMemo(createCars, []);

  const trails = useMemo(
    () =>
      createRunTrails({
        runs: MAX_TRAINS,
        segments: MAX_TRAIL_SEGMENTS,
        color: TRAIL_COLOR,
        opacity: TRAIL_OPACITY,
        width: TRAIL_WIDTH,
        fade: TAIL_FADE,
      }),
    []
  );

  const sprites = useMemo(() => createRunLights(MAX_LIGHTS), []);
  const routes = useRef(new Map<string, Point[] | null>());
  const playheads = useRef(new Map<string, number>());

  const runs = useMemo(() => {
    // Ways between fixes are found once, and kept while they're in use.
    const previous = routes.current;
    const kept = new Map<string, Point[] | null>();

    const cached: Routes = (key, find) => {
      const route = kept.has(key)
        ? kept.get(key)!
        : previous.has(key)
          ? previous.get(key)!
          : find();

      kept.set(key, route);

      return route;
    };

    const peak = isPeak();

    const result = trains
      .slice(0, MAX_TRAINS)
      .map((train) => follow(train, network, index, epoch, cached, peak))
      .filter((run): run is Run => run !== null);

    routes.current = kept;

    return result;
  }, [trains, network, index, epoch]);

  useFollowCandidates(
    "train",
    useMemo(
      () =>
        runs.map(({ train, fixes }): Candidate => ({
          id: train.id,
          label: LINE_NAMES[train.line],
          moving: fixes[fixes.length - 1].s - fixes[0].s > MOVING,
        })),
      [runs]
    )
  );

  useEffect(() => {
    const positions = trails.segments.array;
    const stamps = trails.times.array;
    const owners = trails.owner.array;
    let n = 0;
    runs.forEach(({ points, times }, train) => {
      for (let i = 0; i < points.length - 1 && n < MAX_TRAIL_SEGMENTS; i++) {
        const [ax, ay, az] = points[i];
        const [bx, by, bz] = points[i + 1];

        if (Number.isNaN(times[i]) || Number.isNaN(times[i + 1])) continue;

        if (ax === bx && az === bz) continue;
        const lift = RAIL_TOP + TRAIL_HEIGHT;
        positions.set([ax, ay + lift, az, bx, by + lift, bz], n * 6);
        stamps.set([times[i], times[i + 1]], n * 2);
        owners[n] = train;
        n++;
      }
    });
    trails.segments.needsUpdate = trails.times.needsUpdate = true;
    trails.owner.needsUpdate = true;
    trails.lines.geometry.instanceCount = n;

    const present = new Set(runs.map(({ train }) => train.id));

    for (const id of playheads.current.keys()) {
      if (!present.has(id)) playheads.current.delete(id);
    }
  }, [runs, trails]);

  useEffect(() => {
    cars.windowsLit.value = lights;
  }, [cars, lights]);

  useEffect(
    () => () => {
      cars.mesh.geometry.dispose();
      cars.mesh.material.dispose();
      cars.mesh.dispose();
      trails.lines.geometry.dispose();
      trails.material.dispose();
      sprites.sprite.material.dispose();
    },
    [cars, trails, sprites]
  );

  useFrame((_, delta) => {
    const target = (Date.now() - DELAY - epoch) / 1000;
    const { light, tint } = sprites;
    let lit = 0;

    const show = (at: Vector3, tone: Color, intensity: number) => {
      if (intensity <= 0 || lit >= MAX_LIGHTS) return;
      light.setXYZW(lit, at.x, at.y + RAIL_TOP + LIGHT_HEIGHT, at.z, intensity);
      tint.setXYZ(lit, tone.r, tone.g, tone.b);
      lit++;
    };

    let count = 0;
    const watched = followed("train");
    runs.forEach((run, i) => {
      const { train, fixes } = run;
      const latest = fixes[fixes.length - 1].time;
      // Run on toward now less DELAY; wait at the last fix for the next,
      // then make the time up.
      let playhead = playheads.current.get(train.id);

      if (playhead === undefined) {
        playhead = Math.min(target, latest);
      } else {
        const rate =
          1 + Math.min(Math.max((target - playhead) / CATCH_UP, 0), 2);

        playhead = Math.min(playhead + delta * rate, target, latest);
      }

      playheads.current.set(train.id, playhead);
      trails.playheads.array[i] = playhead;

      // The fix is taken as the middle of the train; it runs toward +s.
      const head = distanceAt(run, playhead) + run.length / 2;
      let offset = 0;

      for (const car of run.cars) {
        if (count >= MAX_CARS) break;
        pointAt(run, head - offset, front);
        pointAt(run, head - offset - car.length, back);
        centre.addVectors(front, back).multiplyScalar(0.5);
        centre.y += RAIL_TOP;
        along.subVectors(front, back);

        if (along.lengthSq() > 1e-6) {
          rotation.setFromUnitVectors(FORWARD, along.normalize());
        }

        matrix.compose(
          centre,
          rotation,
          scale.set(car.width, car.height, car.length)
        );
        cars.mesh.setMatrixAt(count, matrix);
        color.setHex(car.tint).toArray(cars.tints.array, count * 3);
        count++;
        offset += car.length + GAP;
      }

      if (train.id === watched) {
        pointAt(run, head, nose);
        pointAt(run, head - run.length, tail);
        centre.addVectors(nose, tail).multiplyScalar(0.5);
        publish({
          x: centre.x,
          y: centre.y + RAIL_TOP,
          z: centre.z,
          heading: Math.atan2(nose.x - tail.x, -(nose.z - tail.z)),
          length: run.length,
        });
      }

      if (lights > run.switchOn) {
        show(pointAt(run, head + 0.2, front), HEAD, 1);
        show(pointAt(run, head - run.length - 0.2, back), TAIL, 0.8);
      }
    });

    cars.mesh.count = count;
    cars.mesh.instanceMatrix.needsUpdate = true;
    cars.tints.needsUpdate = true;
    sprites.sprite.count = lit;
    sprites.sprite.visible = lit > 0;
    light.needsUpdate = tint.needsUpdate = true;
  });

  return (
    <>
      <primitive object={cars.mesh} name="trains" />
      <primitive object={trails.lines} name="train trails" />
      <primitive object={sprites.sprite} name="train lights" />
    </>
  );
}
