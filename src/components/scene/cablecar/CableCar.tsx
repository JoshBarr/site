import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from "three/webgpu";
import { sceneNow } from "../clock";
import { castsNearShadow } from "../landmarks/nearShadow";
import { createModelMaterial } from "../models/lod";
import { TileIndex } from "../terrain/manifest";
import { RAIL_TOP } from "../trains/network";
import { Tracks } from "../trains/Railway";
import { orient } from "../trains/run";
import { CAR, createCableCarGeometry } from "./model";
import { CableCarLine, loadCableCarLine, pointAlong } from "./line";
import { addDays, carsAt, dayAt, dayStart, Run, runsOn } from "./timetable";
import { Schedule, useTimetable } from "./useTimetable";

const matrix = new Matrix4();
const rotation = new Quaternion();
const front = new Vector3();
const back = new Vector3();
const centre = new Vector3();
const along = new Vector3();
const ONE = new Vector3(1, 1, 1);

/** The runs of the day in Wellington at `time`, and when that day is. */
function dayOf(timetable: Schedule, line: CableCarLine, time: number) {
  const day = dayAt(time);

  return {
    from: dayStart(day),
    until: dayStart(addDays(day, 1)),
    runs: runsOn(timetable, line.stops, day),
  };
}

/** The two cars, run to the timetable at the scene's time. */
function Cars({
  line,
  timetable,
  lights,
}: {
  line: CableCarLine;
  timetable: Schedule;
  lights: number;
}) {
  const cars = useMemo(() => {
    const { material, lit } = createModelMaterial({ roughness: 0.5 });
    const mesh = new InstancedMesh(createCableCarGeometry(), material, 2);
    // They move every frame; their bounds would always be stale.
    mesh.frustumCulled = false;
    castsNearShadow(mesh);

    return { mesh, material, lit };
  }, []);

  const today = useRef<{ from: number; until: number; runs: Run[] } | null>(
    null
  );

  useEffect(() => {
    today.current = null;
  }, [timetable, line]);

  useEffect(() => {
    cars.lit.value = lights;
  }, [cars, lights]);

  useEffect(
    () => () => {
      cars.mesh.geometry.dispose();
      cars.material.dispose();
      cars.mesh.dispose();
    },
    [cars]
  );

  useFrame(() => {
    const now = sceneNow();
    let day = today.current;

    if (!day || now < day.from || now >= day.until) {
      day = today.current = dayOf(timetable, line, now);
    }

    carsAt(day.runs, now).forEach((at, car) => {
      const way = line.ways[car];
      // Its middle: at either end, the car's still all on the track.
      const middle = CAR.length / 2 + at * (way.length - CAR.length);
      pointAlong(way, middle + CAR.length / 2, front);
      pointAlong(way, middle - CAR.length / 2, back);
      centre.addVectors(front, back).multiplyScalar(0.5);
      centre.y += RAIL_TOP;
      orient(along.subVectors(front, back), rotation);
      cars.mesh.setMatrixAt(car, matrix.compose(centre, rotation, ONE));
    });

    cars.mesh.instanceMatrix.needsUpdate = true;
  });

  return <primitive object={cars.mesh} name="cable cars" />;
}

/**
 * The Wellington Cable Car: its track, and its two cars running to Metlink's
 * timetable, there being no live positions for them. `lights` (0..1), how
 * far through lighting-up, lights their windows for night.
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
      {timetable && <Cars line={line} timetable={timetable} lights={lights} />}
    </>
  );
}
