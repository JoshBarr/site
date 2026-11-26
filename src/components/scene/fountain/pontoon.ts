import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// The fountain's pontoon: an octagon afloat, railed round its deck, with a
// drum in the middle that carries the nozzles. Sizes are by eye from a photo,
// scaled by a runabout alongside it, so they're guesses.

/** Across its flats, m. */
const HULL_ACROSS = 8;

/** How far its sides stand out of the water, and how far down they go, m. */
const FREEBOARD = 1.2;
const DRAFT = 0.6;

/** The dark band about the waterline reaches this far up, m. */
const BAND = 0.3;

/** The drum in the middle: across its flats, and its height off the deck, m. */
const DRUM_ACROSS = 3;
const DRUM_HEIGHT = 1;

/** The nozzles' boss on top of the drum, m. */
const BOSS_RADIUS = 0.4;
const BOSS_HEIGHT = 0.3;

/** The railing: its height, how far in from the edge, posts to a side, m. */
const RAIL_HEIGHT = 0.9;
const RAIL_INSET = 0.15;
const POSTS = 4;
const RAIL_SIZE = 0.05;
const POST_SIZE = 0.06;

/** The nozzles stand this high above the water, m. */
export const NOZZLE_HEIGHT = FREEBOARD + DRUM_HEIGHT + BOSS_HEIGHT;

/** How far out its corners are, m. */
export const PONTOON_RADIUS = HULL_ACROSS / 2 / Math.cos(Math.PI / 8);

/** Greys, as the scene's drawn in. */
const GREY = {
  hull: 0.62,
  band: 0.22,
  drum: 0.6,
  boss: 0.3,
  rail: 0.25,
};

const corner = (across: number) => across / 2 / Math.cos(Math.PI / 8);

/** Flat-faced, every face its own, painted `grey`. */
function painted(geometry: BufferGeometry, grey: number) {
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  flat.computeVertexNormals();

  const count = flat.getAttribute("position").count;
  const tint = new Float32Array(count * 3).fill(grey);
  flat.setAttribute("color", new BufferAttribute(tint, 3));

  return flat;
}

/** An octagonal prism from `y0` to `y1`, its flats square to x and z. */
function octagon(across: number, y0: number, y1: number, grey: number) {
  const r = corner(across);
  const prism = new CylinderGeometry(r, r, y1 - y0, 8, 1, false, Math.PI / 8);
  prism.translate(0, (y0 + y1) / 2, 0);

  return painted(prism, grey);
}

/** The railing round the deck: two rails a side, and posts along them. */
function railing() {
  const r = PONTOON_RADIUS - RAIL_INSET / Math.cos(Math.PI / 8);
  const parts: BufferGeometry[] = [];

  // CylinderGeometry's corners, from thetaStart π/8: x = r sin θ, z = r cos θ.
  const at = (i: number): [number, number] => {
    const theta = Math.PI / 8 + (i * Math.PI) / 4;

    return [r * Math.sin(theta), r * Math.cos(theta)];
  };

  for (let i = 0; i < 8; i++) {
    const [x0, z0] = at(i);
    const [x1, z1] = at(i + 1);
    const length = Math.hypot(x1 - x0, z1 - z0);
    const heading = Math.atan2(z1 - z0, x1 - x0);

    for (const height of [RAIL_HEIGHT, RAIL_HEIGHT / 2]) {
      const rail = new BoxGeometry(length, RAIL_SIZE, RAIL_SIZE);
      rail.rotateY(-heading);
      rail.translate((x0 + x1) / 2, FREEBOARD + height, (z0 + z1) / 2);
      parts.push(painted(rail, GREY.rail));
    }

    for (let p = 0; p < POSTS; p++) {
      const t = p / POSTS;
      const post = new BoxGeometry(POST_SIZE, RAIL_HEIGHT, POST_SIZE);

      post.translate(
        x0 + (x1 - x0) * t,
        FREEBOARD + RAIL_HEIGHT / 2,
        z0 + (z1 - z0) * t
      );

      parts.push(painted(post, GREY.rail));
    }
  }

  return parts;
}

/**
 * The pontoon, its waterline at y 0 and centred on the origin, as one
 * geometry with a grey in its `color`.
 */
export function createPontoonGeometry() {
  const boss = painted(
    new CylinderGeometry(BOSS_RADIUS, BOSS_RADIUS, BOSS_HEIGHT, 12),
    GREY.boss
  );

  boss.translate(0, FREEBOARD + DRUM_HEIGHT + BOSS_HEIGHT / 2, 0);

  const parts = [
    // A hair wider, so it shows over the hull's own side.
    octagon(HULL_ACROSS + 0.02, -DRAFT, BAND, GREY.band),
    octagon(HULL_ACROSS, BAND, FREEBOARD, GREY.hull),
    octagon(DRUM_ACROSS, FREEBOARD, FREEBOARD + DRUM_HEIGHT, GREY.drum),
    boss,
    ...railing(),
  ];

  const merged = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());

  if (!merged) throw new Error("fountain pontoon: parts don't merge");

  return merged;
}
