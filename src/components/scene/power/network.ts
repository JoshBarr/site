import type { Span, Structure } from "./grid";
import {
  clampPoint,
  drawnHeight,
  earthPoint,
  gantryHeight,
  kindOf,
  SPECS,
  TowerKind,
  TowerSpec,
} from "./towers";

// From Transpower's structures and spans to towers facing along their lines
// and the wires strung between them. The data says which structures are
// joined, not which conductor goes where: that's worked out here, and it's
// plausible, not surveyed.

type Point = [x: number, y: number, z: number];

/** On the ground plane: world x and z. */
type Flat = [x: number, z: number];

export interface PlacedTower {
  kind: TowerKind;
  /** World position of its foot. */
  position: Point;
  /** Turn about the vertical that points its z along the line, radians. */
  yaw: number;
  /** Foot to top as drawn, m. */
  height: number;
}

/** Floats to a wire in `wires`: from (xyz), to (xyz), sag, gauge. */
export const WIRE_STRIDE = 8;

interface PowerNetwork {
  towers: PlacedTower[];
  /**
   * Each wire hangs between two points, dipping `sag` m below the straight
   * line between them at mid-span, and is drawn `gauge` m thick.
   */
  wires: Float32Array;
}

/**
 * Conductors sag about this much for the square of their span, m per m²
 * (some 6 m over 300 m), but long spans across valleys are strung tighter:
 * no more than MAX_SAG of the span.
 */
const SAG = 7e-5;
const MAX_SAG = 0.04;

/** However near the ground comes, a span hangs at least this much of itself. */
const MIN_SAG = 0.006;

/** Conductors are kept this far over the ground, m, by sagging less. */
const CLEARANCE = 6.5;

/** Earth wires are lighter and strung tighter: this much of the conductors' sag. */
const EARTH_SAG = 0.75;
const EARTH_GAUGE = 0.055;

/** Conductors land on a gantry's beam this far apart, m, by voltage. */
function phaseGap(kv: number) {
  return kv >= 220 ? 3 : 2.4;
}

interface Node {
  kind: TowerKind;
  spec: TowerSpec;
  kv: number;
  position: Point;
  height: number;
  /** Its spans, by their place in the list. */
  spans: number[];
  /** Unit vectors on the ground along its line and across it (its z and x). */
  along: Flat;
  across: Flat;
}

/** A conductor's end: where, how high over the foot, how far left of the span. */
interface End {
  point: Point;
  y: number;
  lateral: number;
}

const dot = (a: Flat, b: Flat) => a[0] * b[0] + a[1] * b[1];

function unit([x, z]: Flat, fallback: Flat = [0, 1]): Flat {
  const length = Math.hypot(x, z);

  return length > 1e-6 ? [x / length, z / length] : fallback;
}

const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Which way a structure's line runs through it: along the two of its spans
 * most nearly opposite, so it squares up to the angle it turns the line
 * through. A substation's gantries count as one direction; a gantry faces
 * the towers it's strung from.
 */
function lineThrough(node: Node, ways: { to: Flat; gantry: boolean }[]): Flat {
  const sum = (list: Flat[]): Flat => [
    list.reduce((x, way) => x + way[0], 0),
    list.reduce((z, way) => z + way[1], 0),
  ];

  const all = ways.map((way) => way.to);

  if (all.length === 0) return [0, 1];

  if (node.kind === "gantry") return unit(sum(all), all[0]);

  const gantries = ways.flatMap((way) => (way.gantry ? [way.to] : []));
  const towers = ways.flatMap((way) => (way.gantry ? [] : [way.to]));

  if (gantries.length > 0) towers.push(unit(sum(gantries), gantries[0]));

  let best: Flat = towers[0];
  let opposite = Infinity;

  for (let i = 0; i < towers.length; i++) {
    for (let j = i + 1; j < towers.length; j++) {
      const facing = dot(towers[i], towers[j]);

      if (facing < opposite) {
        opposite = facing;
        best = unit(
          [towers[i][0] - towers[j][0], towers[i][1] - towers[j][1]],
          towers[i]
        );
      }
    }
  }

  return best;
}

/**
 * Which of a tower's circuits each of its spans carries. A span alone on
 * its side of the tower takes them all; where a line forks, or fans out to
 * a substation's gantries, they're dealt out left to right.
 */
function dealCircuits(node: Node, ways: { span: number; to: Flat }[]) {
  const { arms, circuits } = node.spec;
  const dealt = new Map<number, number[]>();

  const leftToRight = circuits
    .map((_, i) => i)
    .sort(
      (a, b) =>
        mean(circuits[a].map((arm) => arms[arm].x)) -
        mean(circuits[b].map((arm) => arms[arm].x))
    );

  for (const ahead of [true, false]) {
    const side = ways
      .filter((way) => dot(node.along, way.to) >= 0 === ahead)
      .sort((a, b) => dot(node.across, a.to) - dot(node.across, b.to));

    side.forEach((way, i) => {
      if (side.length === 1) {
        dealt.set(way.span, leftToRight);

        return;
      }

      const from = Math.min(
        Math.floor((i * circuits.length) / side.length),
        circuits.length - 1
      );

      const to = Math.floor(((i + 1) * circuits.length) / side.length);
      dealt.set(way.span, leftToRight.slice(from, Math.max(to, from + 1)));
    });
  }

  return dealt;
}

/** A point `x` across a structure and `y` up it. */
function pointOn(node: Node, x: number, y: number): Point {
  return [
    node.position[0] + node.across[0] * x,
    node.position[1] + y,
    node.position[2] + node.across[1] * x,
  ];
}

/**
 * The conductors' ends a tower offers a span, a list to a circuit, the
 * circuits and a flat circuit's conductors in order from the span's left
 * (looking along `left`'s span); a stacked circuit's from the top.
 */
function circuitEnds(node: Node, dealt: number[], left: Flat): End[][] {
  // Whether the tower's own left is the span's.
  const facing = dot(node.across, left) >= 0 ? 1 : -1;

  return dealt
    .map((circuit) => {
      const ends = node.spec.circuits[circuit].map((arm): End => {
        const { x, y } = clampPoint(
          node.spec,
          node.spec.arms[arm],
          node.height
        );

        return { point: pointOn(node, x, y), y, lateral: x * facing };
      });

      const flat =
        Math.max(...ends.map((end) => end.y)) -
          Math.min(...ends.map((end) => end.y)) <
        0.5;

      return flat ? ends.sort((a, b) => a.lateral - b.lateral) : ends;
    })
    .sort(
      (a, b) =>
        mean(a.map((end) => end.lateral)) - mean(b.map((end) => end.lateral))
    );
}

/**
 * Where a gantry takes the conductors a tower sends it: side by side along
 * its beam, a circuit's together, in the order they leave the tower.
 */
function landings(node: Node, sent: End[][], left: Flat): End[][] {
  const facing = dot(node.across, left) >= 0 ? 1 : -1;
  const gap = phaseGap(node.kv);
  const widest = Math.max(...sent.map((circuit) => circuit.length));
  const y = node.height - node.spec.head / 2;

  return sent.map((circuit, i) =>
    circuit.map((_, j): End => {
      const lateral =
        (i - (sent.length - 1) / 2) * (widest * gap + 1.5) +
        (j - (circuit.length - 1) / 2) * gap;

      return { point: pointOn(node, lateral * facing, y), y, lateral };
    })
  );
}

/** The `count` of these circuits nearest `lateral`, still left to right. */
function nearest(circuits: End[][], count: number, lateral: number) {
  const off = (circuit: End[]) =>
    Math.abs(mean(circuit.map((end) => end.lateral)) - lateral);

  return circuits
    .map((circuit, i) => ({ circuit, i }))
    .sort((a, b) => off(a.circuit) - off(b.circuit) || a.i - b.i)
    .slice(0, count)
    .sort((a, b) => a.i - b.i)
    .map(({ circuit }) => circuit);
}

/**
 * Stands each structure at `place` (an easting, northing and ground height
 * to a world point), turned to its line, and strings the spans: conductors
 * circuit to circuit, an earth wire peak to peak, each span's sagging
 * together and no lower than clears the ground, which is drawn
 * `verticalScale` times as high as it is.
 */
export function layOut(
  structures: Structure[],
  spans: Span[],
  place: (easting: number, northing: number, ground: number) => Point,
  verticalScale: number
): PowerNetwork {
  const nodes = structures.map(
    ([easting, northing, ground, height, type, kv]): Node => {
      const kind = kindOf(type, kv);
      const spec = SPECS[kind];

      return {
        kind,
        spec,
        kv,
        position: place(easting, northing, ground),
        height: drawnHeight(spec, type === "X" ? gantryHeight(kv) : height),
        spans: [],
        along: [0, 1],
        across: [1, 0],
      };
    }
  );

  spans.forEach(([a, b], i) => {
    nodes[a].spans.push(i);
    nodes[b].spans.push(i);
  });

  const toward = (from: Node, to: Node): Flat =>
    unit([
      to.position[0] - from.position[0],
      to.position[2] - from.position[2],
    ]);

  const dealt = nodes.map((node, i) => {
    const ways = node.spans.map((span) => {
      const other =
        nodes[spans[span][0] === i ? spans[span][1] : spans[span][0]];

      return { span, to: toward(node, other), gantry: other.kind === "gantry" };
    });

    node.along = lineThrough(node, ways);
    // A structure's x is its z turned a quarter clockwise, seen from above.
    node.across = [node.along[1], -node.along[0]];

    return dealCircuits(node, ways);
  });

  const wires: number[] = [];

  const string = (from: End, to: End, sag: number, gauge: number) =>
    wires.push(...from.point, ...to.point, sag, gauge);

  spans.forEach(([a, b, at, rise], span) => {
    const from = nodes[a];
    const to = nodes[b];
    const along = toward(from, to);
    const left: Flat = [along[1], -along[0]];

    const offered = [from, to].map((node, end) =>
      node.kind === "gantry"
        ? null
        : circuitEnds(node, dealt[end === 0 ? a : b].get(span) ?? [], left)
    );

    // A gantry takes whatever the tower sends; two towers, what both carry.
    const count = Math.min(...offered.map((ends) => ends?.length ?? Infinity));

    if (!Number.isFinite(count) || count === 0) return;

    const kept = offered.map(
      (ends, end) =>
        ends &&
        nearest(
          ends,
          count,
          mean((offered[1 - end] ?? ends).flat().map((other) => other.lateral))
        )
    );

    const [fromEnds, toEnds] = kept.map(
      (ends, end) =>
        ends ??
        landings(
          end === 0 ? from : to,
          // SAFETY: only one end can be a gantry (count would be infinite).
          kept[1 - end] as End[][],
          left
        )
    );

    const pairs = fromEnds.flatMap((circuit, i) =>
      circuit
        .slice(0, toEnds[i].length)
        .map((end, j) => [end, toEnds[i][j]] as const)
    );

    if (pairs.length === 0) return;

    // The lowest conductors decide how far the span may sag over the
    // nearest ground, and the rest hang as they do.
    const length = Math.hypot(
      to.position[0] - from.position[0],
      to.position[2] - from.position[2]
    );

    const t = Math.min(Math.max(at, 0.05), 0.95);
    const low = (ends: readonly End[]) => Math.min(...ends.map((end) => end.y));
    const lowFrom = low(pairs.map(([end]) => end));
    const lowTo = low(pairs.map(([, end]) => end));

    const room =
      lowFrom + (lowTo - lowFrom) * t - CLEARANCE - verticalScale * rise;

    const sag = Math.max(
      Math.min(
        length * length * SAG,
        length * MAX_SAG,
        room / (4 * t * (1 - t))
      ),
      length * MIN_SAG
    );

    // A gantry has no conductors of its own to go by.
    const gauge = Math.max(
      ...[from, to].map((node) =>
        node.kind === "gantry" ? 0 : node.spec.gauge
      )
    );

    for (const [start, end] of pairs) string(start, end, sag, gauge);

    // Earth wires run tower to tower, the leftmost to the leftmost.
    const peaks = [from, to].map((node) => {
      const facing = dot(node.across, left) >= 0 ? 1 : -1;

      return node.spec.earth
        .map((peak): End => {
          const { x, y } = earthPoint(node.spec, peak, node.height);

          return { point: pointOn(node, x, y), y, lateral: x * facing };
        })
        .sort((p, q) => p.lateral - q.lateral);
    });

    for (let i = 0; i < Math.min(peaks[0].length, peaks[1].length); i++) {
      string(peaks[0][i], peaks[1][i], sag * EARTH_SAG, EARTH_GAUGE);
    }
  });

  return {
    towers: nodes.map(({ kind, position, along, height }) => ({
      kind,
      position,
      yaw: Math.atan2(along[0], along[1]),
      height,
    })),
    wires: new Float32Array(wires),
  };
}
