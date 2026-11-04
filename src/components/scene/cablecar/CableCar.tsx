import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Color,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from "three/webgpu";
import { sceneNow, useSeek } from "../clock";
import { castsNearShadow } from "../landmarks/nearShadow";
import { createModelMaterial } from "../models/lod";
import { TileIndex } from "../terrain/manifest";
import { RAIL_TOP } from "../trains/network";
import { Tracks } from "../trains/Railway";
import { orient } from "../trains/run";
import { createRunTrails } from "../trains/Trains";
import { CAR, createCableCarGeometry } from "./model";
import { CableCarLine, CarWay, loadCableCarLine, pointAlong } from "./line";
import {
  addDays,
  carsAt,
  carsOn,
  dayAt,
  dayStart,
  Run,
  runsOn,
} from "./timetable";
import { createTerminal } from "./terminal";
import { Schedule, useTimetable } from "./useTimetable";

const matrix = new Matrix4();
const rotation = new Quaternion();
const front = new Vector3();
const back = new Vector3();
const centre = new Vector3();
const along = new Vector3();
const ONE = new Vector3(1, 1, 1);

/** Orange, against the scene's greys: it's data, like the trains' and buses'. */
const TRAIL_COLOR = new Color(1, 0.6, 0.2);
const TRAIL_OPACITY = 0.45;

/** Pixels. */
const TRAIL_WIDTH = 2;

/** Seconds between the points of a car's trail. */
const TRAIL_STEP = 1;

/** Two runs of both cars, a few minutes each, at TRAIL_STEP. */
const MAX_TRAIL_SEGMENTS = 4096;

/** Above the railhead, m: inside the car, so it comes out behind it. */
const TRAIL_HEIGHT = 1.6;

/**
 * Behind a car its trail fades out by age, s: whole at the car, gone this
 * far back. As the trains'.
 */
const TAIL_FADE = 2 * 60;

type Trails = ReturnType<typeof createRunTrails>;

/** Puts the car `at` (0 at the top to 1 at the bottom) on `way`. */
function place(way: CarWay, at: number) {
  // Its middle: at either end, the car's still all on the track.
  const middle = CAR.length / 2 + at * (way.length - CAR.length);
  pointAlong(way, middle + CAR.length / 2, front);
  pointAlong(way, middle - CAR.length / 2, back);
  centre.addVectors(front, back).multiplyScalar(0.5);
  centre.y += RAIL_TOP;
}

/**
 * Lays each car's trail down the line on `runs`, each point stamped with
 * when the car's there, s from `epoch`: the trails show only as far as the
 * scene's time has got.
 */
function layTrails(
  trails: Trails,
  line: CableCarLine,
  runs: Run[],
  epoch: number
) {
  const positions = trails.segments.array;
  const stamps = trails.times.array;
  const owners = trails.owner.array;
  const last = [new Vector3(), new Vector3()];
  let n = 0;

  for (const run of runs) {
    const from = run.times[0];
    const until = run.times[run.times.length - 1];

    carsOn(run, from).forEach((at, car) => {
      place(line.ways[car], at);
      last[car].copy(centre);
    });

    for (let time = from; time < until; time += TRAIL_STEP * 1000) {
      const next = Math.min(time + TRAIL_STEP * 1000, until);

      carsOn(run, next).forEach((at, car) => {
        place(line.ways[car], at);
        const { x, y, z } = last[car];
        last[car].copy(centre);

        // Standing at a stop.
        if ((x === centre.x && z === centre.z) || n >= MAX_TRAIL_SEGMENTS) {
          return;
        }

        positions.set(
          [x, y + TRAIL_HEIGHT, z, centre.x, centre.y + TRAIL_HEIGHT, centre.z],
          n * 6
        );
        stamps.set([(time - epoch) / 1000, (next - epoch) / 1000], n * 2);
        owners[n] = car;
        n++;
      });
    }
  }

  trails.segments.needsUpdate = trails.times.needsUpdate = true;
  trails.owner.needsUpdate = true;
  trails.lines.geometry.instanceCount = n;
}

/** The runs of the day in Wellington at `time`, and when that day is. */
function dayOf(timetable: Schedule, line: CableCarLine, time: number) {
  const day = dayAt(time);

  return {
    from: dayStart(day),
    until: dayStart(addDays(day, 1)),
    runs: runsOn(timetable, line.stops, day),
  };
}

/**
 * The two cars, run to the timetable at the scene's time, with trails
 * behind them.
 */
function Cars({
  line,
  timetable,
  lights,
}: {
  line: CableCarLine;
  timetable: Schedule;
  lights: number;
}) {
  const { epoch } = useSeek();

  const cars = useMemo(() => {
    const { material, lit } = createModelMaterial({ roughness: 0.5 });
    const mesh = new InstancedMesh(createCableCarGeometry(), material, 2);
    // They move every frame; their bounds would always be stale.
    mesh.frustumCulled = false;
    castsNearShadow(mesh);

    return { mesh, material, lit };
  }, []);

  const trails = useMemo(
    () =>
      createRunTrails({
        runs: 2,
        segments: MAX_TRAIL_SEGMENTS,
        color: TRAIL_COLOR,
        opacity: TRAIL_OPACITY,
        width: TRAIL_WIDTH,
        fade: TAIL_FADE,
      }),
    []
  );

  /** Which runs the trails are laid down, and from when. */
  const laid = useRef("");

  const today = useRef<{ from: number; until: number; runs: Run[] } | null>(
    null
  );

  useEffect(() => {
    today.current = null;
    laid.current = "";
  }, [timetable, line]);

  useEffect(() => {
    cars.lit.value = lights;
  }, [cars, lights]);

  useEffect(
    () => () => {
      cars.mesh.geometry.dispose();
      cars.material.dispose();
      cars.mesh.dispose();
      trails.lines.geometry.dispose();
      trails.material.dispose();
    },
    [cars, trails]
  );

  useFrame(() => {
    const now = sceneNow();
    let day = today.current;

    if (!day || now < day.from || now >= day.until) {
      day = today.current = dayOf(timetable, line, now);
    }

    // The run under way (or last finished), and the one before it, its
    // trail still fading.
    let run = 0;

    while (run + 1 < day.runs.length && day.runs[run + 1].times[0] <= now) {
      run++;
    }

    const runs = day.runs.slice(Math.max(run - 1, 0), run + 1);
    const key = `${epoch} ${day.from} ${run}`;

    if (laid.current !== key) {
      laid.current = key;
      layTrails(trails, line, runs, epoch);
    }

    trails.playheads.array[0] = trails.playheads.array[1] =
      (now - epoch) / 1000;

    carsAt(day.runs, now).forEach((at, car) => {
      place(line.ways[car], at);
      orient(along.subVectors(front, back), rotation);
      cars.mesh.setMatrixAt(car, matrix.compose(centre, rotation, ONE));
    });

    cars.mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <primitive object={cars.mesh} name="cable cars" />
      <primitive object={trails.lines} name="cable car trails" />
    </>
  );
}

/** The top terminus, glazed, so a car's seen standing in it. */
function Terminal({
  index,
  line,
  lights,
}: {
  index: TileIndex;
  line: CableCarLine;
  lights: number;
}) {
  const terminal = useMemo(
    () => createTerminal(index, line.ways[0]),
    [index, line]
  );

  useEffect(() => terminal.light(lights), [terminal, lights]);
  useEffect(() => () => terminal.dispose(), [terminal]);

  return (
    <>
      <primitive object={terminal.body} name="cable car terminal" />
      <primitive object={terminal.windows} name="cable car terminal glass" />
    </>
  );
}

/**
 * The Wellington Cable Car: its track, its top terminus, and its two cars
 * running to Metlink's timetable, there being no live positions for them,
 * with orange trails. `lights` (0..1), how far through lighting-up, lights
 * their windows for night.
 */
export function CableCar({
  index,
  lights = 0,
}: {
  index: TileIndex;
  lights?: number;
}) {
  const [line, setLine] = useState<CableCarLine | null>(null);
  const timetable = useTimetable();

  useEffect(() => {
    loadCableCarLine(index).then(setLine, (e) => console.error(e));
  }, [index]);

  if (!line) return null;

  return (
    <>
      <Tracks network={line.network} />
      <Terminal index={index} line={line} lights={lights} />
      {timetable && <Cars line={line} timetable={timetable} lights={lights} />}
    </>
  );
}
