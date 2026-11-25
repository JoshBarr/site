import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Frustum, Matrix4, Sphere, Vector3 } from "three/webgpu";
import { sceneNow, useSeek } from "../clock";
import { seaLevel } from "../environment";
import {
  type Candidate,
  followed,
  next,
  publish,
  useFollowCandidates,
  useFollowSpots,
} from "../follow/store";
import { loadBuildingIndex } from "../buildings/manifest";
import { pixelAngle } from "../landmarks/common";
import { switchedOff } from "../stats";
import { verticalScale } from "../terrain/Terrain";
import { loadTreeIndex } from "../trees/manifest";
import { nztmToWorld, type TileIndex } from "../terrain/manifest";
import type { HeightQuery } from "../terrain/Terrain";
import { FlockSim, TRAIL_EVERY, TRAIL_POINTS } from "./boids";
import {
  type Flock,
  flocksOf,
  isAbout,
  type Plan,
  planAt,
  restingAt,
} from "./habits";
import { createBirdTrails, createFlight } from "./model";
import { type PerchGrid, Perches } from "./perches";
import { type Roofs, roofAbove, roofsOf } from "./roofs";
import { useBirds } from "./useBirds";

/** Flocks are flown this near, m, and drawn as far as they've flown. */
const RANGE = 6000;

/** Birds flown at once at most: desktop, and phones. */
const MAX_BIRDS = 3000;
const MAX_BIRDS_MOBILE = 1200;

/** Over the buildings by at least this much, m. */
const CLEAR = 1;

/**
 * Followed, a flock's birds are drawn at least this many pixels across,
 * and the one the shot's on (a bird of a kind that works the trees) this
 * many: however far the camera's pulled back, there's a bird to see, not
 * only its trail. And those small birds twice as big as life.
 */
const FOLLOWED_PIXELS = 8;
const LEAD_PIXELS = 28;
const LICENCE = 2;

/**
 * Not flown for longer than this, s (off screen, or a stalled frame), a
 * flock's put back where it'd be, rather than flown on.
 */
const STALE = 0.25;

/** The list to follow is made again this often, ms: who's up, who's down. */
const RELIST = 20_000;

/**
 * Up less than this long, s, a flock coming into range starts on the
 * ground, to be seen taking off, rather than already in the air.
 */
const TAKING_OFF = 30;

const eye = new Vector3();
const frustum = new Frustum();
const viewProjection = new Matrix4();
const sphere = new Sphere();
const plan: Plan = { flying: false, since: 0, x: 0, z: 0, heading: 0 };
const rest: Plan = { flying: false, since: 0, x: 0, z: 0, heading: 0 };

/**
 * Wellington's birds: flocks where birders count them (lib/flocks.ts), of
 * as many as usually are, flown about there through the day (./habits.ts,
 * ./boids.ts). Only birds that are up are drawn, and listed to follow: a
 * flock appears as it takes off, and is gone once it's landed; hoppers
 * stay while they're hopping, perched between hops. Only flocks near the
 * camera and on screen, or followed, are flown; the followed one has
 * trails. `sunAltitude`, degrees, says how light it is.
 */
export function Birds({
  index,
  heightAt,
  sunAltitude,
}: {
  index: TileIndex;
  heightAt: RefObject<HeightQuery | null>;
  sunAltitude: number;
}) {
  const summary = useBirds();
  const roofs = useRef<Roofs | null>(null);
  const perches = useRef<Perches | null>(null);

  // How high the buildings reach, so the flocks keep over them.
  useEffect(() => {
    loadBuildingIndex().then(
      (buildings) => (roofs.current = roofsOf(buildings.manifest)),
      (e) => console.error("[birds] buildings:", e)
    );
  }, []);

  // The trees the hoppers hop between; without them drawn, no hoppers.
  useEffect(() => {
    if (switchedOff("trees")) return;

    loadTreeIndex().then(
      (trees) =>
        (perches.current = new Perches(trees, () => verticalScale.value)),
      (e) => console.error("[birds] trees:", e)
    );
  }, []);
  const seek = useSeek();
  const spots = useFollowSpots("bird");

  const mobile = useMemo(
    () => window.matchMedia("(pointer: coarse)").matches,
    []
  );

  const flocks = useMemo(
    () =>
      summary
        ? flocksOf(summary, (e, n) => nztmToWorld(index.manifest, e, n))
        : [],
    [summary, index]
  );

  const flight = useMemo(
    () => createFlight(mobile ? MAX_BIRDS_MOBILE : MAX_BIRDS),
    [mobile]
  );

  // A segment behind each bird to each of the points of its trail.
  const trails = useMemo(
    () => createBirdTrails(flight.capacity * TRAIL_POINTS),
    [flight]
  );

  useEffect(
    () => () => {
      flight.mesh.geometry.dispose();
      flight.mesh.material.dispose();
      trails.lines.geometry.dispose();
      trails.material.dispose();
    },
    [flight, trails]
  );

  /** The flocks being flown, by id. */
  const sims = useRef(new Map<string, FlockSim>());
  const last = useRef<number | null>(null);

  /**
   * Of a followed flock that works the trees, the bird the shot's on, and
   * the way it last flew.
   */
  const lead = useRef({ id: "", bird: 0, heading: 0 });

  // A jump in time, or new sites: every flock put back where it'd be.
  useEffect(() => {
    sims.current.clear();
    last.current = null;
  }, [seek, flocks]);

  // Who can be followed: the flocks in the air, as of when the list was
  // last made.
  const [listedAt, setListedAt] = useState(sceneNow);

  useEffect(() => {
    setListedAt(sceneNow());
    const timer = setInterval(() => setListedAt(sceneNow()), RELIST);

    return () => clearInterval(timer);
  }, [seek]);

  const sun = useRef(sunAltitude);
  sun.current = sunAltitude;

  const candidates = useMemo(
    () =>
      flocks
        // The sun as it is when the list's made, not as it moves.
        .filter(
          (flock) =>
            isAbout(flock, listedAt) &&
            planAt(flock, listedAt, sun.current).flying
        )
        .map((flock): Candidate => ({
          id: flock.id,
          label: flock.label,
          detail: flock.birds === 1 ? "1 bird" : `${flock.birds} birds`,
          moving: true,
          // Hoppers only where there are trees.
          drawn: flock.habit.hops
            ? () => perches.current?.hasTrees(flock.id) ?? false
            : undefined,
        })),
    [flocks, listedAt]
  );

  useFollowCandidates("bird", candidates);

  useFrame(({ camera }) => {
    const now = sceneNow();
    const time = now / 1000;
    const dt = last.current === null ? Infinity : time - last.current;
    last.current = time;

    const ground = heightAt.current;
    const sea = seaLevel.value;

    const over = roofs.current;

    // The ground or the sea; over buildings, clear of their roofs.
    const surface = (x: number, z: number) => {
      const below = ground?.(x, z) ?? sea;
      const roof = over ? roofAbove(over, x, z) : 0;

      return Math.max(roof > 0 ? below + roof + CLEAR : below, sea);
    };

    // The same, without the buildings: hoppers' trees stand among them.
    const bare = (x: number, z: number) => Math.max(ground?.(x, z) ?? sea, sea);

    camera.getWorldPosition(eye);
    viewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    frustum.setFromProjectionMatrix(viewProjection);

    // The flocks to fly: those about, nearest first, and the one followed.
    const watched = followed("bird");
    const near: { flock: Flock; distance: number }[] = [];

    for (const flock of flocks) {
      const distance = Math.hypot(flock.x - eye.x, flock.z - eye.z);
      const reach = RANGE + flock.habit.roam;

      if (flock.id === watched) near.push({ flock, distance: -1 });
      else if (distance < reach && isAbout(flock, now)) {
        near.push({ flock, distance });
      }
    }

    near.sort((a, b) => a.distance - b.distance);

    const flown = new Set<string>();
    let room = flight.capacity;
    let drawn = 0;
    let laid = 0;
    const place = flight.place.array;
    const shape = flight.shape.array;
    const lines = trails.segments.array;
    const ages = trails.ages.array;
    const trailLength = TRAIL_POINTS * TRAIL_EVERY;
    spots.begin();

    for (const { flock } of near) {
      if (flock.birds > room) continue;

      const { habit } = flock;
      const watching = flock.id === watched;
      planAt(flock, now, sunAltitude, plan);
      let sim = sims.current.get(flock.id);

      // Not flown for a moment (off screen, or a stalled frame): out of
      // date, so put back where it'd be now rather than flown on.
      const gap = sim ? time - sim.stepped : Infinity;
      const stale = !(gap >= 0 && gap <= STALE);

      // Down, and not coming down: nothing to see.
      if (!plan.flying && (!sim || stale)) {
        if (watching) next();
        continue;
      }

      // Hoppers are where the trees are: none till they're read, and none
      // at a site without any.
      let trees: PerchGrid | undefined;

      if (habit.hops) {
        const grid =
          perches.current?.around(
            flock.id,
            flock.x,
            flock.z,
            habit.roam + habit.hops.patch
          ) ?? null;

        if (!grid?.count) {
          if (watching && grid) next();
          continue;
        }

        trees = grid;
      }

      // On screen? Where it is, or one not flown yet, where it'd be.
      if (sim) {
        sphere.center.set(sim.middle.x, sim.middle.y, sim.middle.z);
        sphere.radius = sim.extent / 2 + habit.span * 12 + 20;
      } else if (habit.hops) {
        // In the trees about the site.
        const below = surface(flock.x, flock.z);
        sphere.center.set(flock.x, below + habit.height[1], flock.z);
        sphere.radius = habit.roam + 50;
      } else {
        const below = surface(plan.x, plan.z);
        sphere.center.set(plan.x, below + habit.height[1], plan.z);
        sphere.radius = habit.spacing * Math.sqrt(flock.birds) + 50;
      }

      const seen = frustum.intersectsSphere(sphere);

      // Off screen, and not followed: left as it is, unflown.
      if (!seen && !watching) {
        if (sim) {
          room -= flock.birds;
          flown.add(flock.id);
        }

        continue;
      }

      if (!sim) {
        // Just up: off the ground, as it's seen. Hoppers start in trees.
        const start =
          plan.since < TAKING_OFF && !habit.hops
            ? restingAt(flock, rest)
            : plan;

        sim = new FlockSim(flock, start, surface, trees, time);
        sims.current.set(flock.id, sim);
        sim.step(Math.min(Math.max(dt, 0), 0.1), plan, surface, time, bare);
      } else if (stale) {
        sim.place(plan, surface, time);
        sim.stepped = time;
      } else {
        sim.step(gap, plan, surface, time, bare);
      }

      // All down and staying down: gone, and following it, on to another.
      if (!plan.flying && sim.down() === sim.n) {
        if (watching) next();
        continue;
      }

      room -= flock.birds;
      flown.add(flock.id);

      const { middle, extent } = sim;
      spots.add(flock.id, middle.x, middle.y, middle.z, Math.max(extent, 10));

      let leading = -1;

      if (watching && habit.hops) {
        // One bird of it, close: its flock's spread through the trees,
        // too far apart to see together. The first found flying.
        const on = lead.current;

        if (on.id !== flock.id) {
          on.id = flock.id;
          on.bird = Math.max(sim.settled.indexOf(0), 0);
          on.heading = plan.heading;
        }

        leading = on.bird;

        const at = sim.position.subarray(leading * 3, leading * 3 + 3);
        const going = sim.velocity.subarray(leading * 3, leading * 3 + 3);
        const flat = Math.hypot(going[0], going[2]);

        // Clockwise from north (-z); sitting, the way it came.
        if (flat > 0.3) on.heading = Math.atan2(going[0], -going[2]);

        publish({
          x: at[0],
          y: at[1],
          z: at[2],
          heading: on.heading,
          length: habit.span * 12,
          speed: flat,
          climb: going[1],
          ground: Boolean(sim.settled[leading]),
          height: Math.max(at[1] - bare(at[0], at[2]), 0),
          steady: true,
        });
      } else if (watching) {
        const mean = sim.mean();
        const flat = Math.hypot(mean.x, mean.z);
        const down = sim.down() > sim.n / 2;

        publish({
          x: middle.x,
          y: middle.y,
          z: middle.z,
          // Clockwise from north (-z).
          heading: flat > 0.3 ? Math.atan2(mean.x, -mean.z) : plan.heading,
          length: Math.max(extent * 0.6, habit.span * 12, 6),
          speed: flat,
          climb: mean.y,
          ground: down,
          height: Math.max(middle.y - surface(middle.x, middle.z), 0),
        });
      }

      if (!seen) continue;

      const tones = Math.round(habit.body * 100) + Math.min(habit.wing, 0.99);
      // Hoppers sitting between hops are about still; others down are not.
      const perched = Boolean(habit.hops) && plan.flying;

      const span = habit.span * (watching && habit.hops ? LICENCE : 1);

      for (let i = 0; i < sim.n; i++) {
        if (sim.settled[i] && !perched) continue;

        const o = drawn * 4;
        place[o] = sim.position[i * 3];
        place[o + 1] = sim.position[i * 3 + 1];
        place[o + 2] = sim.position[i * 3 + 2];
        place[o + 3] = sim.heading[i];

        // Followed: big enough to see, from wherever it's looked at.
        shape[o] = watching
          ? Math.max(
              span,
              Math.hypot(
                place[o] - eye.x,
                place[o + 1] - eye.y,
                place[o + 2] - eye.z
              ) *
                pixelAngle.value *
                (i === leading ? LEAD_PIXELS : FOLLOWED_PIXELS)
            )
          : span;
        shape[o + 1] = tones;
        shape[o + 2] = sim.wing[i];
        shape[o + 3] = sim.bank[i];
        drawn++;

        // Trails behind the followed flock only: from where each bird is
        // back through where it's been.
        if (!watching) continue;

        let x = sim.position[i * 3];
        let y = sim.position[i * 3 + 1];
        let z = sim.position[i * 3 + 2];
        let age = 0;

        for (let k = 0; k < TRAIL_POINTS; k++) {
          const slot = (sim.newest - k + TRAIL_POINTS) % TRAIL_POINTS;
          const t = (i * TRAIL_POINTS + slot) * 3;
          const taken = sim.taken[slot];
          const then = Number.isNaN(taken) ? 1 : (time - taken) / trailLength;
          const l = laid * 6;
          lines[l] = x;
          lines[l + 1] = y;
          lines[l + 2] = z;
          x = sim.trail[t];
          y = sim.trail[t + 1];
          z = sim.trail[t + 2];
          lines[l + 3] = x;
          lines[l + 4] = y;
          lines[l + 5] = z;
          ages[laid * 2] = age;
          ages[laid * 2 + 1] = age = Math.min(then, 1);
          laid++;
        }
      }
    }

    // Those gone out of range, or out of the day, forgotten.
    for (const id of sims.current.keys()) {
      if (!flown.has(id)) sims.current.delete(id);
    }

    flight.mesh.count = drawn;
    flight.mesh.visible = drawn > 0;

    for (const attribute of [flight.place, flight.shape]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, drawn * 4);
      attribute.needsUpdate = true;
    }

    trails.segments.clearUpdateRanges();
    trails.segments.addUpdateRange(0, laid * 6);
    trails.segments.needsUpdate = true;
    trails.ages.clearUpdateRanges();
    trails.ages.addUpdateRange(0, laid * 2);
    trails.ages.needsUpdate = true;
    trails.lines.geometry.instanceCount = laid;
    trails.lines.visible = laid > 0;
  });

  return (
    <>
      <primitive object={flight.mesh} name="birds" />
      <primitive object={trails.lines} name="bird trails" />
    </>
  );
}
