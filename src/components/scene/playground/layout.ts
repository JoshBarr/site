import { GROUND } from "./site";

// Te Aro Mahana, the playground in Frank Kitts Park, laid out in metres east
// and north of ANCHOR on the NZTM grid. Its outline and the equipment's spots
// agree with OpenStreetMap; the shapes painted on the ground and the sizes
// are by eye from aerial photos and photos taken in it, not from drawings.

export type Point = [east: number, north: number];

/** What the ground is painted, in its real colours. */
export const PAINT = {
  asphalt: "#5e6062",
  garden: "#4d5c3a",
  border: "#b9b9b2",
  blue: "#8cbbdb",
  ochre: "#d6a443",
  white: "#eef1f2",
  pale: "#c3cfd6",
  deep: "#3c86c8",
  green: "#7cc98d",
} as const;

type Paint = keyof typeof PAINT;

/** A painted area, its outline rounded off unless `sharp`. */
export interface Patch {
  paint: Paint;
  outline: Point[];
  sharp?: boolean;
  /** Painted only inside this patch, by its index in SURFACE. */
  within?: number;
}

/** A painted band along a line, `width` m across. */
export interface Band {
  paint: Paint;
  line: Point[];
  width: number;
  within?: number;
}

/** The painted rectangle: west, south, east, north. */
export const EXTENT: [number, number, number, number] = [-19, -18, 23, 15];

/**
 * Zig and zag about a straight line from `from` to `to`, `swing` m either
 * side, turning every `every` m: the playground's lightning stripes.
 */
function zigzag(from: Point, to: Point, swing: number, every: number) {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const turns = Math.max(1, Math.round(length / every));

  // Square to the line, to its left.
  const side = [
    -(to[1] - from[1]) / length,
    (to[0] - from[0]) / length,
  ] as const;

  return Array.from({ length: turns + 1 }, (_, i): Point => {
    const t = i / turns;
    const s = i % 2 === 0 ? swing : -swing;

    return [
      from[0] + (to[0] - from[0]) * t + side[0] * s,
      from[1] + (to[1] - from[1]) * t + side[1] * s,
    ];
  });
}

const WEST_ZONE = 2;
const EAST_ZONE = 6;
const WAKA_ZONE = 7;
const SWING_ZONE = 8;

/** Painted areas, bottom to top. */
export const PATCHES: Patch[] = [
  // The paths, all one sweep of asphalt under everything.
  {
    paint: "asphalt",
    outline: [
      [-16.6, 12.2],
      [-14.8, 13.4],
      [-6, 13.9],
      [0, 14.3],
      [9, 12.2],
      [17.5, 9.8],
      [21, 8.6],
      [21.5, 3],
      [21, -6],
      [21.5, -11],
      [19.5, -12.6],
      [8, -14.6],
      [2.5, -15.4],
      [-1, -17.4],
      [-5, -17.8],
      [-12, -16.8],
      [-15, -14.5],
      [-15.4, -4],
      [-16.8, 4],
    ],
    sharp: true,
  },
  // Planted edge along the promenade, round the west zone's foot.
  {
    paint: "garden",
    outline: [
      [-18.7, 14],
      [-15, 14],
      [-15, -14.6],
      [-4, -15.2],
      [-3.6, -16.8],
      [-12, -17.3],
      [-16.5, -16],
      [-18.7, -12],
    ],
  },
  // The west zone: lighthouse, slides and swings, on light blue.
  {
    paint: "blue",
    outline: [
      [-15.75, 11.25],
      [-14.5, 11.9],
      [-10, 12],
      [-6.2, 11.8],
      [-5, 10.6],
      [-5.6, 8.2],
      [-5.6, 5.6],
      [-4.6, 3.6],
      [-2.6, 3],
      [-0.9, 2.6],
      [-0.6, 0.5],
      [-1, -3.5],
      [-1.5, -7.5],
      [-1.3, -10.5],
      [-2.5, -13.4],
      [-5.75, -15],
      [-10.75, -15.25],
      [-13, -14.25],
      [-14, -12],
      [-14.5, -6],
      [-15, -1],
      [-16, 4.5],
      [-16.1, 9],
    ],
  },
  // Round garden bed in its north-east corner, edged in concrete.
  {
    paint: "border",
    outline: [
      [-5.6, 9.7],
      [-3.2, 10.6],
      [-0.3, 9.9],
      [0.7, 7.5],
      [0.2, 4.8],
      [-1.3, 3.2],
      [-4, 3.2],
      [-5.6, 4.8],
      [-5.9, 7.2],
    ],
  },
  {
    paint: "garden",
    outline: [
      [-5.3, 9.4],
      [-3.2, 10.2],
      [-0.6, 9.6],
      [0.3, 7.5],
      [-0.2, 5],
      [-1.4, 3.6],
      [-3.8, 3.6],
      [-5.2, 5],
      [-5.5, 7.2],
    ],
  },
  // Beds on the east side, by the promenade.
  {
    paint: "garden",
    outline: [
      [15.2, -3.2],
      [17.4, -2.9],
      [18.2, -5],
      [17.6, -7.6],
      [15.8, -7.8],
      [15, -5.6],
    ],
  },
  // The east zone: carousel under the sail and the fishnet climber.
  {
    paint: "blue",
    outline: [
      [3.5, 3],
      [6, 3.6],
      [9, 3.5],
      [10.5, 3],
      [12.5, 2],
      [14.4, 0.6],
      [15.6, -1.4],
      [16.3, -3.6],
      [17, -6],
      [18.5, -8],
      [19.8, -10],
      [19.4, -11.2],
      [13.5, -12.5],
      [8.5, -13.5],
      [2.4, -14.6],
      [1.6, -12],
      [1.6, -8.5],
      [1.1, -5],
      [1, -3],
      [1.5, -1.2],
      [2.2, 0.6],
    ],
  },
  // The waka's sea: deep blue, green zigzags running through it.
  {
    paint: "deep",
    outline: [
      [1.8, -8.4],
      [6, -7.2],
      [11, -6.8],
      [16.5, -6.3],
      [18.6, -8],
      [19.8, -10],
      [19.4, -11.2],
      [13.5, -12.5],
      [8.5, -13.5],
      [2.4, -14.6],
      [1.5, -11.5],
    ],
    sharp: true,
    within: EAST_ZONE,
  },
  // The swing in the north-east, on its own patch.
  {
    paint: "blue",
    outline: [
      [8.2, 7],
      [9.2, 9.4],
      [10, 11.2],
      [13.2, 11],
      [17.6, 8.8],
      [16.6, 6],
      [15.8, 4],
      [13.6, 3],
      [11.6, 4.2],
      [9.6, 5.2],
    ],
  },
  // Pale ground round the carousel.
  {
    paint: "pale",
    outline: [
      [3, 1.5],
      [5, 2.6],
      [10, 2.4],
      [12.8, 0.6],
      [13.6, -1.8],
      [11, -2.6],
      [7, -2.2],
      [3.4, -1.6],
      [2, -0.4],
    ],
    within: EAST_ZONE,
  },
];

/** Painted bands, over the patches. */
export const BANDS: Band[] = [
  // Two ochre lightning stripes down the west zone, from the swings to the
  // lighthouse.
  {
    paint: "ochre",
    line: zigzag([-12.6, 13], [-9.4, -5.5], 1.4, 4.2),
    width: 1.9,
    within: WEST_ZONE,
  },
  {
    paint: "ochre",
    line: zigzag([-8.2, 13], [-6.4, 1.5], 1.4, 4.2),
    width: 1.9,
    within: WEST_ZONE,
  },
  // A pale ring round the lighthouse's foot, and a white swirl sweeping
  // from it across the path into the east zone.
  {
    paint: "pale",
    line: [
      [-12.8, -4.5],
      [-12.6, -9],
      [-10.5, -12],
      [-7, -12.6],
      [-4.6, -11.4],
    ],
    width: 1.6,
    within: WEST_ZONE,
  },
  {
    paint: "white",
    line: [
      [-13.6, -3],
      [-14, -8.5],
      [-12.4, -13.2],
      [-8.4, -14.3],
      [-5, -13.2],
      [-2.6, -10.6],
      [0.5, -9.3],
      [3, -9.2],
      [4.2, -8.7],
    ],
    width: 0.9,
  },
  // White arcs round the carousel and the climber's ends.
  {
    paint: "white",
    line: [
      [4.8, 1.8],
      [6.2, 2.9],
      [8, 3],
      [9.6, 2.3],
    ],
    width: 0.5,
    within: EAST_ZONE,
  },
  {
    paint: "white",
    line: [
      [4.2, -2.6],
      [2.6, -3.4],
      [2.3, -5],
      [3.2, -6.4],
    ],
    width: 0.5,
    within: EAST_ZONE,
  },
  {
    paint: "white",
    line: [
      [11.6, -2.4],
      [13.6, -2.2],
      [14.6, -3.8],
      [14, -5.6],
    ],
    width: 0.5,
    within: EAST_ZONE,
  },
  // Green and light blue zigzags through the waka's sea.
  {
    paint: "green",
    line: zigzag([1.5, -8.9], [19.5, -8], 0.7, 1.7),
    width: 0.45,
    within: WAKA_ZONE,
  },
  {
    paint: "blue",
    line: zigzag([1.5, -10.8], [20, -9.8], 0.6, 1.7),
    width: 0.4,
    within: WAKA_ZONE,
  },
  {
    paint: "green",
    line: zigzag([1.5, -12.8], [20, -11.4], 0.7, 1.7),
    width: 0.45,
    within: WAKA_ZONE,
  },
  // Concentric rings under the nest swing, and the pale tail of them
  // running down to the carousel.
  {
    paint: "pale",
    line: [
      [14.6, 4.4],
      [13, 3],
      [11, 1.6],
    ],
    width: 1.2,
  },
  {
    paint: "white",
    line: ring([12.2, 7.6], 2.6),
    width: 0.35,
    within: SWING_ZONE,
  },
  {
    paint: "white",
    line: ring([12.2, 7.6], 1.3),
    width: 0.3,
    within: SWING_ZONE,
  },
];

function ring([e, n]: Point, radius: number): Point[] {
  return Array.from({ length: 33 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;

    return [e + Math.cos(a) * radius, n + Math.sin(a) * radius];
  });
}

/** Where things stand. Heights are above the ground, m. */
/** A spot and a height, or a heading, with it. */
type Spot = [east: number, north: number, value: number];

interface Equipment {
  lighthouse: Point;
  tubeSlide: Spot[];
  openSlide: Spot[];
  swings: [Point, Point];
  nestSwing: [Point, Point];
  carousel: Point;
  sail: Spot[];
  fishnet: { at: Point; radius: number }[];
  waka: { bow: Point; stern: Point };
  boxes: Spot[];
  tables: Spot[];
  benches: Spot[];
  lamps: Point[];
}

export const EQUIPMENT: Equipment = {
  /** Centre of the lighthouse's tower. */
  lighthouse: [-7.6, -8.8],
  /** The yellow tube slide off its gallery, top to bottom, with heights. */
  tubeSlide: [
    [-7.1, -6.4, 4.4],
    [-6.5, -5.3, 3.95],
    [-7.2, -4.4, 3.45],
    [-6.6, -3.4, 2.95],
    [-5.5, -1.2, 1.8],
    [-4.6, 0.6, 0.8],
    [-4.3, 1.3, 0.5],
  ],
  /** The open steel slide off the lighthouse's lower deck. */
  openSlide: [
    [-9.2, -7.2, 1.9],
    [-9.7, -4.8, 1.4],
    [-9.4, -2.5, 0.9],
    [-8.4, -1.1, 0.5],
    [-7.9, -0.6, 0.4],
  ],
  /** Two-bay swing set: its top beam, end to end. */
  swings: [
    [-9.2, 10.6],
    [-12, 2.3],
  ],
  /** The nest swing's beam, end to end. */
  nestSwing: [
    [10.6, 5.9],
    [13.9, 9.8],
  ],
  /** The carousel's centre, under the sail. */
  carousel: [5.9, 0.1],
  /** The shade sail's corners and their heights. */
  sail: [
    [2.75, 1.4, 4.2],
    [10.1, 1.75, 3],
    [9, -1.25, 4.3],
    [0.9, -2.5, 2.8],
  ],
  /**
   * The fishnet climber: hoops along its spine, west to east, each a circle
   * of `radius` m sunk to leave about three quarters of it standing.
   */
  fishnet: [
    { at: [3.2, -6], radius: 2.3 },
    { at: [5.4, -5.6], radius: 1.9 },
    { at: [7.2, -5.3], radius: 1.7 },
    { at: [9, -5.2], radius: 1.6 },
    { at: [11.6, -5.1], radius: 1.9 },
  ],
  /** The waka: bow (its carved head) and stern (its tall post). */
  waka: {
    bow: [4.8, -12],
    stern: [16.8, -9.6],
  },
  /** Timber boxes to climb, near the waka's head: where, and how big. */
  boxes: [
    [1.3, -13, 0.7],
    [2.1, -13.6, 0.55],
    [1.5, -14.2, 0.45],
  ],
  /** Picnic tables: where, and which way they run (compass degrees). */
  tables: [
    [-1.8, 12.8, 100],
    [19.6, -0.4, 10],
    [-3, -4, 20],
  ],
  /** Benches: where, and which way they face (compass degrees). */
  benches: [
    [1.3, -0.6, 250],
    [16.6, -5.6, 280],
  ],
  /** Light poles. */
  lamps: [
    [16.8, 1.8],
    [5.5, 8.6],
  ],
};

/** Bare ground, m (before the terrain's vertical scale), bilinear. */
export function groundAt(east: number, north: number) {
  const { step, west, south, columns, heights } = GROUND;
  const rows = heights.length / columns;
  const u = Math.min(Math.max((east - west) / step, 0), columns - 1.001);
  const v = Math.min(Math.max((north - south) / step, 0), rows - 1.001);
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const at = (a: number, b: number) => heights[b * columns + a];
  const lower = at(i, j) * (1 - fu) + at(i + 1, j) * fu;
  const upper = at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu;

  return lower * (1 - fv) + upper * fv;
}
