import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Color,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  NormalBlending,
} from "three/webgpu";
import {
  attribute,
  float,
  normalize,
  positionGeometry,
  select,
  smoothstep,
  uniform,
  varying,
} from "three/tsl";
import { LineSegments2 } from "three/examples/jsm/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { sceneNow, useSeek } from "../clock";
import { TrailMaterial } from "../trailMaterial";
import { type Satellite, type Sighting, sight } from "./orbits";
import {
  createSkyGroup,
  createSkySprites,
  limitingMagnitude,
  SKY_PRIORITY,
  SKY_RADIUS,
  visibility,
} from "./skySprites";
import { useSatellites } from "./useSatellites";

// The satellites passing over: points where the sun catches them against a
// dark enough sky, each trailing the last minute of its way across. Data,
// so the trails are coloured, as the other layers' are.

/** Most drawn at once; a busy twilight has a dozen or so. */
const MAX_SHOWN = 32;

/** Seconds of trail, and between its points. */
const TRAIL = 60;
const STEP = 1;

const POINTS = TRAIL / STEP;

/** Data's colour on an otherwise grey scene: teal, for orbits. */
const TRAIL_COLOR = new Color(0.4, 0.95, 0.9);

const TRAIL_WIDTH = 1.5;

/** At the satellite, fading to nothing a minute back. */
const TRAIL_OPACITY = 0.35;

/** Floats per segment: start and end xyz, times, magnitudes. */
const STRIDE = 10;

/** Below this many degrees, the ground or the sea hides them. */
const HORIZON = -2;

/** Seconds since the trails' epoch, as their points' times are. */
const trailNow = uniform(0);

function createTrails() {
  const geometry = new LineSegmentsGeometry();

  const array = new Float32Array(MAX_SHOWN * POINTS * STRIDE);
  const segments = new InstancedInterleavedBuffer(array, STRIDE, 1);

  const add = (name: string, size: number, offset: number) =>
    geometry.setAttribute(
      name,
      new InterleavedBufferAttribute(segments, size, offset)
    );

  add("instanceStart", 3, 0);
  add("instanceEnd", 3, 3);
  add("instanceTimeStart", 1, 6);
  add("instanceTimeEnd", 1, 7);
  add("instanceMagnitudeStart", 1, 8);
  add("instanceMagnitudeEnd", 1, 9);
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
  material.fog = false;
  // Behind everything, as the points.
  material.depthNode = float(1);

  // The template quad's y is below 0.5 at a segment's start, above at its end.
  const end = <T extends "float" | "vec3">(type: T, name: string) =>
    select(
      positionGeometry.y.lessThan(0.5),
      attribute<T>(`instance${name}Start`, type),
      attribute<T>(`instance${name}End`, type)
    );

  const age = trailNow.sub(end("float", "Time")).div(TRAIL).clamp(0, 1);
  const fade = float(1).sub(age);
  const up = normalize(end("vec3", "")).y;

  material.opacityNode = varying(
    fade
      .mul(fade)
      .mul(TRAIL_OPACITY)
      .mul(visibility(end("float", "Magnitude")))
      .mul(smoothstep(-0.01, 0.04, up))
  );

  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = -1;

  return { lines, segments, array };
}

/** A satellite being drawn: its trail's points, by time (ms). */
interface Tracked {
  points: Map<number, Sighting>;
  /** When it was last bright enough to see, ms. */
  seen: number;
}

export function Satellites() {
  const satellites = useSatellites();
  const seek = useSeek();

  const { group, sprite, points, lines, segments, array } = useMemo(() => {
    const group = createSkyGroup();
    const { sprite, points } = createSkySprites(MAX_SHOWN);
    const { lines, segments, array } = createTrails();

    sprite.name = "satellites";
    group.add(lines, sprite);

    return { group, sprite, points, lines, segments, array };
  }, []);

  useEffect(
    () => () => {
      sprite.material.dispose();
      lines.geometry.dispose();
      lines.material.dispose();
    },
    [sprite, lines]
  );

  const tracked = useRef(new Map<number, Tracked>());

  // A new time or new orbits: start the trails over.
  useEffect(() => {
    tracked.current = new Map();
  }, [seek, satellites]);

  useFrame(({ camera }) => {
    group.matrix.makeTranslation(camera.position);
    group.updateMatrixWorld(true);

    const now = sceneNow();
    const limit = limitingMagnitude.value;
    let shown = 0;
    let n = 0;

    trailNow.value = (now - seek.epoch) / 1000;

    if (limit < -3) {
      tracked.current.clear();
    } else {
      for (const satellite of satellites) {
        if (shown >= MAX_SHOWN) break;

        const at = sight(satellite, now);

        if (!at || at.elevation < HORIZON) {
          tracked.current.delete(satellite.id);
          continue;
        }

        let track = tracked.current.get(satellite.id);

        if (at.magnitude < limit) {
          track ??= { points: new Map(), seen: now };
          track.seen = now;
          tracked.current.set(satellite.id, track);
        }

        if (!track) continue;

        if (now - track.seen > TRAIL * 1000) {
          tracked.current.delete(satellite.id);
          continue;
        }

        points.setXYZW(shown++, ...at.direction, at.magnitude);
        n = layTrail(satellite, track, at, now, seek.epoch, array, n);
      }
    }

    // Uploaded only while there's something to draw, or to clear.
    if (shown || sprite.count) points.needsUpdate = true;

    if (n || lines.geometry.instanceCount) segments.needsUpdate = true;

    sprite.count = shown;
    lines.geometry.instanceCount = n;
  }, SKY_PRIORITY);

  return <primitive object={group} />;
}

/**
 * Writes `satellite`'s trail into `out` from segment `n`, from where it is
 * now back a minute along whole STEPs, sighting the ones it hasn't yet;
 * the next free segment.
 */
function layTrail(
  satellite: Satellite,
  { points }: Tracked,
  head: Sighting,
  now: number,
  epoch: number,
  out: Float32Array,
  n: number
) {
  const step = STEP * 1000;
  const newest = Math.floor(now / step) * step;

  for (const time of points.keys()) {
    if (time <= newest - TRAIL * 1000) points.delete(time);
  }

  let from = head;
  let fromTime = now;

  for (let k = 0; k < POINTS; k++) {
    const time = newest - k * step;
    let to = points.get(time);

    if (!to) {
      const sighting = sight(satellite, time);

      if (!sighting) break;
      to = sighting;
      points.set(time, to);
    }

    const o = n++ * STRIDE;

    out.set(from.direction, o);
    out.set(to.direction, o + 3);

    for (let i = 0; i < 6; i++) out[o + i] *= SKY_RADIUS;
    out[o + 6] = (fromTime - epoch) / 1000;
    out[o + 7] = (time - epoch) / 1000;
    out[o + 8] = from.magnitude;
    out[o + 9] = to.magnitude;
    from = to;
    fromTime = time;
  }

  return n;
}
