import { BufferAttribute } from "three/webgpu";

// One tree, shaped per instance in the vertex shader (see material.ts): a
// crown of lobes, each an icosahedron, so it reads as clumps of foliage
// rather than one dome, and a trunk. Each vertex carries where it sits on
// its lobe or the trunk, not a position. Near trees get more lobes, each
// subdivided once; far ones fewer and plainer.

/** Lobes per crown, near and far. Lobe 0 is the top one. */
export const LOBES = { near: 5, far: 3 };
const LOBE_SUBDIVISIONS = { near: 1, far: 0 };
const LOBE_TRUNK_SIDES = { near: 5, far: 3 };

/** Unit icosahedron, subdivided `subdivisions` times (0 or 1). */
function icosphere(subdivisions: number) {
  const t = (1 + Math.sqrt(5)) / 2;

  const points: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);

    return [x / l, y / l, z / l];
  });

  const faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];

  const midpoints = new Map<string, number>();

  const midpoint = (a: number, b: number) => {
    const key = a < b ? `${a}/${b}` : `${b}/${a}`;
    const known = midpoints.get(key);

    if (known !== undefined) return known;
    const [x, y, z] = points[a].map((v, i) => v + points[b][i]);
    const l = Math.hypot(x, y, z);
    points.push([x / l, y / l, z / l]);
    midpoints.set(key, points.length - 1);

    return points.length - 1;
  };

  if (!subdivisions) return { points, faces };

  const split = faces.flatMap(([a, b, c]) => {
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);

    return [
      [a, ab, ca],
      [b, bc, ab],
      [c, ca, bc],
      [ab, bc, ca],
    ];
  });

  return { points, faces: split };
}

/**
 * "lobe" attribute: for the crown, a unit direction from the lobe's centre
 * and the lobe's number; for the trunk, (cos, t, sin) around and up it, and
 * -1.
 */
/** Unit octahedron: 6 vertices, 8 faces, for lobes a few pixels across. */
function octahedron() {
  const points = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  const faces = [
    [0, 2, 4],
    [4, 2, 1],
    [1, 2, 5],
    [5, 2, 0],
    [4, 3, 0],
    [1, 3, 4],
    [5, 3, 1],
    [0, 3, 5],
  ];

  return { points, faces };
}

type Shape = { points: number[][]; faces: number[][] };

/**
 * One tree's vertices and faces, appended: `lobes` copies of `shape`, then
 * a trunk of `sides`. Returns its range in the index.
 */
function appendTree(
  lobe: number[],
  index: number[],
  shape: Shape,
  lobes: number,
  sides: number
) {
  const start = index.length;

  for (let k = 0; k < lobes; k++) {
    const first = lobe.length / 4;

    for (const [x, y, z] of shape.points) lobe.push(x, y, z, k);

    // The shapes' faces wind counter-clockwise seen from outside.
    for (const [a, b, c] of shape.faces) {
      index.push(first + a, first + b, first + c);
    }
  }

  const first = lobe.length / 4;

  for (let s = 0; s < sides; s++) {
    const angle = (s / sides) * Math.PI * 2;
    lobe.push(Math.cos(angle), 0, Math.sin(angle), -1);
    lobe.push(Math.cos(angle), 1, Math.sin(angle), -1);
  }

  for (let s = 0; s < sides; s++) {
    const n = (s + 1) % sides;

    const [b0, h0, b1, h1] = [2 * s, 2 * s + 1, 2 * n, 2 * n + 1].map(
      (i) => first + i
    );

    index.push(b0, h0, b1);
    index.push(b1, h0, h1);
  }

  return { start, count: index.length - start };
}

/**
 * Near: one tree. Far: two in the same buffers, drawn by index range
 * (`FAR_RANGES`): icosahedron lobes, and octahedron lobes for trees far
 * enough off that a lobe is a few pixels. Only the range drawn is shaded.
 */
function createLobedArrays(detail: "near" | "far") {
  const lobe: number[] = [];
  const index: number[] = [];
  const sides = LOBE_TRUNK_SIDES[detail];
  const lobes = LOBES[detail];

  const ranges = [
    appendTree(lobe, index, icosphere(LOBE_SUBDIVISIONS[detail]), lobes, sides),
  ];

  if (detail === "far") {
    ranges.push(appendTree(lobe, index, octahedron(), lobes, sides));
  }

  return {
    lobe: new Float32Array(lobe),
    index: new Uint16Array(index),
    ranges,
  };
}

const lobedArrays = {
  near: createLobedArrays("near"),
  far: createLobedArrays("far"),
};

/** Index ranges of the far trees' two shapes: [icosahedra, octahedra]. */
export const FAR_RANGES = lobedArrays.far.ranges;

/**
 * Fresh attributes over a tree's shared arrays. Each geometry gets its own,
 * since disposing a geometry frees the GPU buffers of every attribute on it.
 */
export function treeAttributes(detail: "near" | "far") {
  const arrays = lobedArrays[detail];

  return {
    lobe: new BufferAttribute(arrays.lobe, 4),
    index: new BufferAttribute(arrays.index, 1),
  };
}

// Shrubs: a few lobes and no trunk, icosahedra close by and octahedra past
// that, in one geometry (`SHRUB_RANGES`) as the far trees.

/** Lobes per shrub. Lobe 0 is the middle one. */
export const SHRUB_LOBES = 3;

const shrubArrays = (() => {
  const lobe: number[] = [];
  const index: number[] = [];

  const ranges = [
    appendTree(lobe, index, icosphere(0), SHRUB_LOBES, 0),
    appendTree(lobe, index, octahedron(), SHRUB_LOBES, 0),
  ];

  return {
    lobe: new Float32Array(lobe),
    index: new Uint16Array(index),
    ranges,
  };
})();

/** Index ranges of the shrubs' two shapes: [icosahedra, octahedra]. */
export const SHRUB_RANGES = shrubArrays.ranges;

/** Fresh attributes over the shrubs' shared arrays, one set per geometry. */
export function shrubAttributes() {
  return {
    lobe: new BufferAttribute(shrubArrays.lobe, 4),
    index: new BufferAttribute(shrubArrays.index, 1),
  };
}
