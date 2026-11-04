import { Vector3 } from "three/webgpu";
import { TileIndex } from "../terrain/manifest";
import { NetworkFile, RAIL_URL, RailNetwork } from "../trains/network";
import type { Stops } from "./timetable";

// The cable car's line, from public/rail/cablecar.json (built by
// scripts/trains/build_cablecar.mjs): its track, as a rail network the
// railway's track is laid along, and each car's way down it.

interface LineFile extends NetworkFile {
  cars: { path: number[]; stops: Stops }[];
}

/** One car's way, Kelburn to Lambton Quay, in world space (the track bed). */
export interface CarWay {
  points: Vector3[];
  /** Metres along it to each point. */
  along: number[];
  length: number;
}

export interface CableCarLine {
  network: RailNetwork;
  ways: [CarWay, CarWay];
  /** Where each stop is, 0 at the top to 1 at the bottom: the cars' mean. */
  stops: Stops;
}

/** The point `distance` m down `way`, into `out`; clamped to its ends. */
export function pointAlong(way: CarWay, distance: number, out: Vector3) {
  const { points, along } = way;
  const d = Math.min(Math.max(distance, 0), way.length);
  let k = 1;

  while (k < points.length - 1 && along[k] < d) k++;

  const t = (d - along[k - 1]) / (along[k] - along[k - 1] || 1);

  return out.lerpVectors(points[k - 1], points[k], t);
}

export async function loadCableCarLine(
  index: TileIndex
): Promise<CableCarLine> {
  const response = await fetch(`${RAIL_URL}/cablecar.json`);

  if (!response.ok) throw new Error(`cable car line: HTTP ${response.status}`);

  const file: LineFile = await response.json();
  const network = new RailNetwork(file, index);

  const ways = file.cars.map(({ path }): CarWay => {
    const points = path.map((i) => new Vector3(...network.point(i)));
    const along = [0];

    for (let k = 1; k < points.length; k++) {
      along.push(along[k - 1] + points[k].distanceTo(points[k - 1]));
    }

    return { points, along, length: along[along.length - 1] };
  });

  if (ways.length !== 2) throw new Error(`cable car line: ${ways.length} ways`);

  const [a, b] = file.cars.map(({ stops }) => stops);

  const stops = Object.fromEntries(
    Object.keys(a)
      .filter((stop) => stop in b)
      .map((stop) => [stop, (a[stop] + b[stop]) / 2])
  );

  return { network, ways: [ways[0], ways[1]], stops };
}
