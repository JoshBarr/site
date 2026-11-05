import { useEffect, useMemo } from "react";
import { PerspectiveCamera, Vector3 } from "three/webgpu";

// Following a vehicle with the camera. The layers that draw vehicles list
// the ones that can be followed and, each frame, publish where the followed
// one is; the camera rig frames it, and the controls pick which.

export type Category = "bus" | "train" | "ship" | "plane";

export const CATEGORIES: Category[] = ["bus", "train", "ship", "plane"];

export interface Candidate {
  id: string;
  /** Shown while it's followed: a route, a ship's name, a callsign. */
  label: string;
  /** Under way, so picked before those standing still, and listed first. */
  moving: boolean;
  /** A word on what it's doing, listed beside it: "12 kn", "on the ground". */
  detail?: string;
  /** On the map now; those that aren't are passed over. Assumed if absent. */
  drawn?: () => boolean;
}

export interface Following {
  category: Category;
  id: string;
  label: string;
}

interface FollowSnapshot {
  following: Following | null;
  counts: Record<Category, number>;
  /** Cut straight to each new subject, rather than flying there. */
  cut: boolean;
}

/** Where the followed vehicle is this frame, as its layer draws it. */
export interface Subject {
  /** World position: the middle of it. */
  x: number;
  y: number;
  z: number;
  /** Radians clockwise from north, the way it's facing. */
  heading: number;
  /** Metres bow to stern: shots stand off in proportion. */
  length: number;
  /** Over the ground, m/s. */
  speed: number;
  /** Up, m/s. */
  climb: number;
  /** Gaining speed, m/s². */
  accel: number;
  /** On the ground (or the sea, the road, the rails). */
  ground: boolean;
  /** Above the ground, m, when it isn't on it. */
  height: number;
}

export const subject: Subject & {
  /** Published since the rig last looked. */
  fresh: boolean;
} = {
  x: 0,
  y: 0,
  z: 0,
  heading: 0,
  length: 10,
  speed: 0,
  climb: 0,
  accel: 0,
  ground: true,
  height: 0,
  fresh: false,
};

const candidates = new Map<Category, Candidate[]>();

/**
 * Where a layer drew its vehicles in the last frame, so one can be picked
 * out by clicking it. A vehicle may have several spots: a train has one for
 * each car.
 */
class Spots {
  ids: string[] = [];
  /** x, y, z, and length, for each. */
  at = new Float32Array(4 * 256);
  count = 0;

  begin() {
    this.count = 0;
  }

  add(id: string, x: number, y: number, z: number, length: number) {
    const i = this.count++;

    if (this.at.length < this.count * 4) {
      const grown = new Float32Array(this.at.length * 2);
      grown.set(this.at);
      this.at = grown;
    }

    this.ids[i] = id;
    this.at.set([x, y, z, length], i * 4);
  }
}

const spots = new Map<Category, Spots>();

/**
 * Whether a vehicle at world x, z is somewhere the camera can be: off the
 * map's faded edges, only its trail shows through the fog. All, until the
 * controls say.
 */
let reachable: (x: number, z: number) => boolean = () => true;

/** Limits what can be picked to where `reach` says. */
export function setReach(reach: (x: number, z: number) => boolean) {
  reachable = reach;
}

/**
 * Whether `id` of `category` was drawn somewhere reachable last frame. One
 * whose layer hasn't said where it's drawn (not yet, or ever) can't be
 * ruled out.
 */
function inReach(category: Category, id: string) {
  const drawn = spots.get(category);
  let placed = false;

  for (let i = 0; drawn && i < drawn.count; i++) {
    if (drawn.ids[i] !== id) continue;

    if (reachable(drawn.at[i * 4], drawn.at[i * 4 + 2])) return true;
    placed = true;
  }

  return !placed;
}

/** Labels in reading order, numbers by value: Route 2 before Route 14. */
const byLabel = new Intl.Collator("en-NZ", { numeric: true });

/**
 * What of `category` can be followed now: drawn, and somewhere reachable.
 * Those under way first, then by label.
 */
export function available(category: Category): Candidate[] {
  return (candidates.get(category) ?? [])
    .filter(({ id, drawn }) => (drawn?.() ?? true) && inReach(category, id))
    .sort(
      (a, b) =>
        Number(b.moving) - Number(a.moving) || byLabel.compare(a.label, b.label)
    );
}

/** Followed since each category's list last went round, so Next doesn't repeat. */
const visited = new Map<Category, Set<string>>();
const listeners = new Set<() => void>();

const countsOf = (): Record<Category, number> => {
  const count = (category: Category) => candidates.get(category)?.length ?? 0;

  return {
    bus: count("bus"),
    train: count("train"),
    ship: count("ship"),
    plane: count("plane"),
  };
};

let snapshot: FollowSnapshot = {
  following: null,
  counts: countsOf(),
  cut: false,
};

function update(following: Following | null, cut = snapshot.cut) {
  snapshot = { following, counts: countsOf(), cut };

  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export const getSnapshot = () => snapshot;

/** The id of the followed vehicle, if it's one of `category`. */
export function followed(category: Category) {
  const { following } = snapshot;

  return following?.category === category ? following.id : null;
}

/** Where the followed vehicle is now. Call from the frame that draws it. */
export function publish(at: Partial<Subject> & Pick<Subject, "x" | "y" | "z">) {
  Object.assign(subject, {
    heading: 0,
    length: 10,
    speed: 0,
    climb: 0,
    accel: 0,
    ground: true,
    height: 0,
    ...at,
    fresh: true,
  });
}

/**
 * One of `category` available now at random, not `avoid`, and not one
 * followed since the list last went round. While any are under way, it's
 * only those, round and round: ships at anchor are a long wait to get past.
 */
function pick(category: Category, avoid?: string): Following | null {
  const all = available(category);
  const moving = all.filter((c) => c.moving);
  const list = moving.length ? moving : all;

  let seen = visited.get(category);

  if (!seen) visited.set(category, (seen = new Set()));
  let pool = list.filter(({ id }) => id !== avoid && !seen.has(id));

  if (!pool.length) {
    seen.clear();
    pool = list.filter(({ id }) => id !== avoid);
  }

  if (!pool.length) return null;
  const { id, label } = pool[Math.floor(Math.random() * pool.length)];
  seen.add(id);

  return { category, id, label };
}

/** Pixels from a vehicle that a click still picks it, however small it's drawn. */
const REACH = 12;

const spot = new Vector3();
const projected = new Vector3();

/** A vehicle drawn near a point on the view. */
export interface Sighting {
  vehicle: Following;
  /** Where it's drawn, -1..1 across and up the view. */
  x: number;
  y: number;
  /** In front of the camera, along its view axis, m. */
  depth: number;
  /** Metres bow to stern. */
  length: number;
}

/**
 * The vehicles drawn near enough the point `x`, `y` (-1..1 across and up
 * the view, as three has it) on a view `height` pixels high to be what was
 * meant, at least `reach` pixels, nearest the point first: each once, at
 * its nearest spot. Some may be hidden behind hills or buildings.
 */
export function vehiclesAt(
  camera: PerspectiveCamera,
  x: number,
  y: number,
  height: number,
  reach = REACH,
  /** Whether a spot this far off can be made out at all, through the haze. */
  visible: (at: Vector3) => boolean = () => true
): Sighting[] {
  // Pixels across a metre one metre away.
  const scale = height / 2 / Math.tan((camera.fov * Math.PI) / 360);
  const near = new Map<string, Sighting & { off: number }>();

  for (const [category, { ids, at, count }] of spots) {
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      spot.set(at[o], at[o + 1], at[o + 2]);
      projected.copy(spot).project(camera);

      if (
        projected.z < -1 ||
        projected.z > 1 ||
        !reachable(spot.x, spot.z) ||
        !visible(spot)
      ) {
        continue;
      }

      const depth = -spot.applyMatrix4(camera.matrixWorldInverse).z;
      const dx = ((projected.x - x) * height * camera.aspect) / 2;
      const dy = ((projected.y - y) * height) / 2;
      const off = Math.hypot(dx, dy);
      const length = at[o + 3];
      const radius = Math.max((length / 2 / depth) * scale, reach);
      const key = `${category}:${ids[i]}`;

      if (off > radius || off >= (near.get(key)?.off ?? Infinity)) continue;
      near.set(key, {
        vehicle: { category, id: ids[i], label: "" },
        x: projected.x,
        y: projected.y,
        depth,
        length,
        off,
      });
    }
  }

  return [...near.values()]
    .sort((a, b) => a.off - b.off)
    .flatMap(({ vehicle, x, y, depth, length }) => {
      const { category, id } = vehicle;
      const candidate = candidates.get(category)?.find((c) => c.id === id);

      if (!candidate) return [];

      return [
        {
          vehicle: { ...vehicle, label: candidate.label },
          x,
          y,
          depth,
          length,
        },
      ];
    });
}

/** Starts following `vehicle`, as picked out on the map. */
export function followVehicle(vehicle: Following) {
  const { category, id } = vehicle;
  let seen = visited.get(category);

  if (!seen) visited.set(category, (seen = new Set()));
  seen.add(id);
  update(vehicle);
}

/** Starts following one of `category`, or the next if already following. */
export function follow(category: Category) {
  const { following } = snapshot;
  update(
    pick(category, following?.category === category ? following.id : undefined)
  );
}

/** On to another of the same category. */
export function next() {
  const { following } = snapshot;

  if (following) update(pick(following.category, following.id));
}

export function stop() {
  if (snapshot.following) update(null);
}

/** Cuts, or flies, to each new subject from now on. */
export function setCut(cut: boolean) {
  if (cut !== snapshot.cut) update(snapshot.following, cut);
}

/** Lists what of `category` can be followed while mounted. */
export function useFollowCandidates(category: Category, list: Candidate[]) {
  useEffect(() => {
    candidates.set(category, list);
    // Labels can fill in later, a route once it's known.
    const { following } = snapshot;

    const current =
      following?.category === category &&
      list.find(({ id }) => id === following.id);

    update(
      current && current.label !== following.label
        ? { ...following, label: current.label }
        : following
    );
  }, [category, list]);

  useEffect(
    () => () => {
      candidates.delete(category);
      update(snapshot.following);
    },
    [category]
  );
}

/** Spots for where `category` is drawn, to fill each frame while mounted. */
export function useFollowSpots(category: Category) {
  const drawn = useMemo(() => new Spots(), []);

  useEffect(() => {
    spots.set(category, drawn);

    return () => {
      if (spots.get(category) === drawn) spots.delete(category);
    };
  }, [category, drawn]);

  return drawn;
}
