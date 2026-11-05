import type { Vector3 } from "three/webgpu";

// Keeping views the scene puts the camera in (handing back from following,
// coming down from the map view, set views, and the arcs flown between them)
// under a low cloud deck: in it, the view's a grey wall.

/** Under a deck, the camera's kept this far beneath its base, m. */
export const DECK_CLEARANCE = 100;

/**
 * Highest a view's put, m: `clear` under a clear sky, or under the deck,
 * whichever's lower.
 */
export function ceilingFor(deck: number | null, clear: number) {
  return deck === null ? clear : Math.min(clear, deck - DECK_CLEARANCE);
}

/**
 * Bringing a view under the ceiling, it tips toward level about what it's
 * aimed at no further than this from straight down, then comes in along
 * the view.
 */
const LEVELLEST = (78 * Math.PI) / 180;

/**
 * Brings a view (the camera, and what it's aimed at) under `ceiling` if the
 * camera's above it: tipped down about the target toward level, the same
 * distance off, then in nearer along the view if that's not enough. A target
 * above the ceiling comes down `nearest` under it first. In place; whether
 * it moved.
 */
export function beneath(
  camera: Vector3,
  target: Vector3,
  ceiling: number,
  nearest: number
) {
  if (camera.y <= ceiling) return false;
  target.y = Math.min(target.y, ceiling - nearest);
  const rise = ceiling - target.y;
  let dx = camera.x - target.x;
  let dz = camera.z - target.z;
  let across = Math.hypot(dx, dz);

  // Straight down on it: from the south, looking north.
  if (across < 1e-6) {
    [dx, dz, across] = [0, 1, 1];
  }

  // No more level than LEVELLEST: nearer, if it would be.
  const off = Math.min(camera.distanceTo(target), rise / Math.cos(LEVELLEST));
  const level = Math.sqrt(Math.max(off * off - rise * rise, 0)) / across;
  camera.set(target.x + dx * level, ceiling, target.z + dz * level);

  return true;
}

/**
 * A flight's height, `y` along the straight way plus `arc` over the top, the
 * arc no higher than the ceiling (the way itself may be, setting off from or
 * landing above it).
 */
export const arcUnder = (y: number, arc: number, ceiling: number) =>
  Math.max(y, Math.min(y + arc, ceiling));
