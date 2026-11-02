import { useEffect } from "react";

// Following a vehicle with the camera. The layers that draw vehicles list
// the ones that can be followed and, each frame, publish where the followed
// one is; the camera rig frames it, and the panel picks which.

export type Category = "bus" | "train" | "ship" | "plane";

export const CATEGORIES: Category[] = ["bus", "train", "ship", "plane"];

export interface Candidate {
  id: string;
  /** Shown while it's followed: a route, a ship's name, a callsign. */
  label: string;
  /** Under way, so picked before those standing still. */
  moving: boolean;
}

export interface Following {
  category: Category;
  id: string;
  label: string;
}

interface FollowSnapshot {
  following: Following | null;
  counts: Record<Category, number>;
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

let snapshot: FollowSnapshot = { following: null, counts: countsOf() };

function update(following: Following | null) {
  snapshot = { following, counts: countsOf() };

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
 * One of `category` at random, not `avoid`, and not one followed since the
 * list last went round. Those under way go first.
 */
function pick(category: Category, avoid?: string): Following | null {
  const list = candidates.get(category) ?? [];
  let seen = visited.get(category);

  if (!seen) visited.set(category, (seen = new Set()));
  let pool = list.filter(({ id }) => id !== avoid && !seen.has(id));

  if (!pool.length) {
    seen.clear();
    pool = list.filter(({ id }) => id !== avoid);
  }

  const moving = pool.filter((c) => c.moving);

  if (moving.length) pool = moving;

  if (!pool.length) return null;
  const { id, label } = pool[Math.floor(Math.random() * pool.length)];
  seen.add(id);

  return { category, id, label };
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
