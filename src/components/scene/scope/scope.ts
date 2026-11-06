import { Matrix4, Quaternion, Vector2, Vector3 } from "three/webgpu";
import { type Satellite, sight } from "../sky/orbits";
import { designFor } from "./craft";

// Following a satellite is watching it through a telescope from the ground.
// The camera comes down off its view to the ground under it, turning up to
// the satellite, then zooms in until it fills a good part of the frame, and
// tracks it across the sky. Let go, or once it's low, it zooms back out and
// goes back up onto the view it left. Three dials say where it's got to:
// `lower`, the camera's way down; `swing`, its turn from one satellite onto
// the next; and `zoom`, the lens.
//
// Zoomed in, it's a stabilised camera on a mount: sprung, a little behind
// the satellite and caught by the odd gust, its autofocus hunting as it
// arrives and now and then after. The stars behind stream past the other
// way, slowed (really they'd cross the frame dozens of times a second).

/** Seconds down to the ground and up to the sky, and back up to the view. */
export const LOWER = 3;
export const RAISE = 2.5;

/** Seconds to zoom in on it, and back out. */
export const ZOOM_IN = 4;
export const ZOOM_OUT = 2;

/** Seconds to turn from one satellite onto the next. */
export const SWING = 2;

/** How fast where it stands eases up, and down, to where it's clear, /s. */
const SETTLE_UP = 3;
const SETTLE_DOWN = 0.5;

/** Lower than this many degrees, the hills are in the way: it's let go. */
export const LOWEST = 10;

/** Zoomed in, the satellite's this much of the frame's height. */
const FILL = 0.7;

/**
 * The narrowest the lens goes, degrees: small satellites far off stay small
 * in the frame rather than the sky's shaders running out of precision.
 */
export const NARROWEST = 0.0012;

/** The air's shimmer, as much of the frame. */
const SHIMMER = 0.002;

/**
 * The mount: sprung at this many Hz, this damped, it trails the satellite
 * by this much of the frame's height at speed.
 */
const MOUNT_HZ = 0.6;
const MOUNT_DAMPING = 0.5;
const LAG = 0.06;

/** A gust or a slip in the drive: frame heights a second, every few seconds. */
const KICK = 0.25;
const KICKS = [2.5, 6.5];

/** The stars behind go by at most this many frame heights a second. */
const STARS_MAX = 0.8;

/** Seconds the autofocus takes to hunt, and between its hunts. */
export const HUNT = 1.2;
const HUNTS = [7, 15];

/** A stateless random number, 0..1, from a seed (mulberry32). */
function random(seed: number) {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The fastest the frame turns about its middle, rad/s, passing overhead. */
const ROLL = 1.5;

/**
 * The satellite's drawn this far off, m, scaled to look its size from
 * there; and focused on there.
 */
export const IMPOSTOR_DISTANCE = 20_000;

const RAD = Math.PI / 180;

const smoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);

  return t * t * (3 - 2 * t);
};

const smootherstep = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);

/** The lens, degrees, for `span` metres to fill FILL of the frame `range` m off. */
export const teleFov = (span: number, range: number) =>
  Math.max((2 * Math.atan(span / (2 * range))) / FILL / RAD, NARROWEST);

export interface Pose {
  position: Vector3;
  quaternion: Quaternion;
  /** Vertical, degrees. */
  fov: number;
  /** Where it's focused: the satellite, as it's drawn. */
  aim: Vector3;
}

export const pose = (): Pose => ({
  position: new Vector3(),
  quaternion: new Quaternion(),
  fov: 50,
  aim: new Vector3(),
});

const Y = new Vector3(0, 1, 0);
const ORIGIN = new Vector3();
const basis = new Matrix4();
const level = new Vector3();
const held = new Vector3();
const twist = new Quaternion();
const sky = new Quaternion();
const forward = new Vector3();
const shake = new Quaternion();
const axis = new Vector3();
const motion = new Vector3();
const inverse = new Quaternion();
const way = new Vector2();
const pull = new Vector2();

/** Looking along `direction`, `up` up the frame. */
function looking(direction: Vector3, up: Vector3, out: Quaternion) {
  return out.setFromRotationMatrix(basis.lookAt(ORIGIN, direction, up));
}

export class Scope {
  /** Watched, or last watched on the way back. */
  satellite: Satellite | null = null;
  /** 0 on the view, 1 on the ground looking up at it. */
  lower = 0;
  /** 0 on the last satellite, 1 on this one. */
  swing = 1;
  /** 0 the view's lens, 1 the telescope's. */
  zoom = 0;
  /** Whether the satellite's drawn close up: its point of light isn't. */
  craftShown = false;

  /** The view it left, to go back to, and its lens. */
  readonly position = new Vector3();
  readonly target = new Vector3();
  fov = 50;
  /** Where the camera stands, m up: over the roofs, seeing over the hills. */
  floor = 0;

  /** Toward it last seen, its range then, m, and where the swing's from. */
  readonly toward = new Vector3(0, 1, 0);
  range = 400_000;
  readonly from = new Vector3(0, 1, 0);
  /** Up the frame, last frame. */
  readonly up = new Vector3(0, 1, 0);
  /** Seconds it's been watching, for the shimmer. */
  time = 0;

  /**
   * The scene's time this frame, epoch ms, as the camera was aimed by it:
   * what draws the satellite reads it too, not the clock again, which may
   * have ticked on a millisecond (5% of the frame, zoomed in).
   */
  now = 0;

  /**
   * Where the mount's aimed off the satellite, frame heights (x right, y
   * up), and how fast that's moving; and as it's been applied, zoomed.
   */
  readonly slip = new Vector2();
  readonly slipping = new Vector2();
  readonly offset = new Vector2();
  /** How the stars behind go across the frame, frame heights a second. */
  readonly drift = new Vector2();
  /** Out of focus, -1..1 (signed: the hunt overshoots), 0 sharp. */
  focus = 0;
  /** Seconds into a hunt, or null; and to the next gust and hunt. */
  hunting: number | null = null;
  untilKick = KICKS[0];
  untilHunt = HUNTS[0];
  /** Whether it's hunted since arriving zoomed in. */
  arrived = false;
  /** Draws so far, for the next random number. */
  draws = 0;

  private random() {
    return random(this.draws++);
  }

  /** On its way down, watching, or on the way back: the camera's not free. */
  get active() {
    return this.lower > 0 || this.satellite !== null;
  }

  /** How much of the clouds still show, 1..0, as it zooms past them. */
  get clouds() {
    return 1 - smoothstep(0, 0.3, this.zoom);
  }

  /** How dark the frame's edges are, 0..1, as through a long lens. */
  get vignette() {
    return smoothstep(0, 0.6, this.zoom);
  }

  /**
   * Starting from the view at `position` toward `target` through `fov`,
   * down (or up) to stand `floor` m up.
   */
  begin(position: Vector3, target: Vector3, fov: number, floor: number) {
    this.position.copy(position);
    this.target.copy(target);
    this.fov = fov;
    this.floor = floor;
    this.up.copy(Y);
    this.time = 0;
    this.slip.set(0, 0);
    this.slipping.set(0, 0);
    this.focus = 0;
    this.hunting = null;
    this.arrived = false;
  }

  /**
   * Over `delta` seconds, toward standing `floor` m up: as the satellite
   * goes across the sky, the hills in the way change. Up quicker than down.
   */
  settle(floor: number, delta: number) {
    const rate = floor > this.floor ? SETTLE_UP : SETTLE_DOWN;
    this.floor += (floor - this.floor) * (1 - Math.exp(-rate * delta));
  }

  /** On by `delta` seconds, toward `wanted` at `now`, or back to the view. */
  step(delta: number, wanted: Satellite | null, now: number) {
    this.time += delta;
    this.now = now;

    if (!this.active && !wanted) return;
    this.autofocus(delta);

    if (wanted && !this.satellite) {
      this.satellite = wanted;
      this.swing = 1;
    }

    // On to another: back out, then across to it.
    if (wanted && wanted !== this.satellite) {
      if (this.zoom > 0) {
        this.zoom = Math.max(this.zoom - delta / ZOOM_OUT, 0);

        return;
      }

      this.from.copy(this.direction(now));
      this.satellite = wanted;
      this.swing = 0;
    }

    if (wanted) {
      this.lower = Math.min(this.lower + delta / LOWER, 1);
      this.swing = Math.min(this.swing + delta / SWING, 1);

      if (this.lower === 1 && this.swing === 1) {
        this.zoom = Math.min(this.zoom + delta / ZOOM_IN, 1);
      }

      return;
    }

    if (this.zoom > 0) {
      this.zoom = Math.max(this.zoom - delta / ZOOM_OUT, 0);

      return;
    }

    this.lower = Math.max(this.lower - delta / RAISE, 0);

    if (this.lower === 0) this.satellite = null;
  }

  /**
   * Hunting for focus: as it arrives zoomed in and every so often after,
   * out, past and back. On the way in or out, soft in the middle of the
   * zoom, where it can't keep up.
   */
  private autofocus(delta: number) {
    if (this.zoom < 0.5) this.arrived = false;

    if (this.zoom === 1) {
      this.untilHunt -= delta;

      if (!this.arrived || this.untilHunt <= 0) {
        this.arrived = true;
        this.hunting ??= 0;
        this.untilHunt = HUNTS[0] + (HUNTS[1] - HUNTS[0]) * this.random();
      }
    }

    if (this.hunting === null) {
      this.focus = this.zoom < 1 ? 0.6 * Math.sin(Math.PI * this.zoom) : 0;

      return;
    }

    this.hunting += delta;
    const u = Math.min(this.hunting / HUNT, 1);
    this.focus = 1.4 * Math.sin(1.5 * Math.PI * u) * (1 - u);

    if (u === 1) {
      this.hunting = null;
      this.focus = 0;
    }
  }

  /**
   * Toward the satellite at `now` in the scene frame, part way over from
   * the last one while swinging; where it was if it can't be worked out.
   */
  direction(now: number) {
    const seen = this.satellite && sight(this.satellite, now);

    if (seen) {
      this.toward.set(...seen.direction);
      this.range = seen.range * 1000;
    }

    if (this.swing === 1) return forward.copy(this.toward);

    // Round the great circle between them, at an even turn.
    axis.crossVectors(this.from, this.toward);

    if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0).cross(this.from);

    if (axis.lengthSq() < 1e-12) axis.set(1, 0, 0);
    const angle = this.from.angleTo(this.toward) * smootherstep(this.swing);

    return forward
      .copy(this.from)
      .applyQuaternion(twist.setFromAxisAngle(axis.normalize(), angle));
  }

  /** The camera at `now`, `delta` seconds on from the last. */
  pose(now: number, delta: number, out: Pose) {
    const direction = this.direction(now);
    const down = smootherstep(this.lower);

    // Straight down, by ratio, so it's not all spent high up; or, from
    // under where it stands, straight up.
    const height = this.position.y - this.floor;
    out.position.copy(this.position);
    out.position.y =
      height >= 0
        ? this.floor + (height + 1) ** (1 - down) - 1
        : this.position.y - height * down;

    // Up the frame: level with the horizon, but turning no faster than
    // ROLL as it passes overhead, where there's no level to be had.
    level.copy(Y).addScaledVector(direction, -direction.y);
    held.copy(this.up).addScaledVector(direction, -direction.dot(this.up));

    if (held.lengthSq() < 1e-8) held.copy(level);

    if (level.lengthSq() < 1e-8) level.copy(held);

    if (held.lengthSq() < 1e-8) held.set(1, 0, 0);
    held.normalize();
    level.normalize();

    const angle = Math.atan2(
      axis.crossVectors(held, level).dot(direction),
      held.dot(level)
    );

    const turn = Math.min(Math.max(angle, -ROLL * delta), ROLL * delta);
    this.up.copy(held).applyQuaternion(twist.setFromAxisAngle(direction, turn));

    // From the view's way of looking to the telescope's.
    looking(direction, this.up, sky);
    looking(
      level.subVectors(this.target, this.position),
      Y,
      out.quaternion
    ).slerp(sky, down);

    // The lens, by ratio, so the zoom reads steady.
    const span = this.satellite ? designFor(this.satellite.name).span : 20;
    const tele = teleFov(span, this.range);
    const zoom = smootherstep(this.zoom);
    out.fov = this.fov * (tele / this.fov) ** zoom;

    this.track(now, direction, out.fov, delta);

    // The mount's aim off it, and the air's shimmer, as far as it's zoomed.
    const frame = out.fov * RAD * zoom;
    const t = this.time;
    this.offset.copy(this.slip).multiplyScalar(zoom);

    const shimmer = (a: number, b: number) =>
      SHIMMER * (Math.sin(t * a) * 0.6 + Math.sin(t * b + 1) * 0.4);

    out.quaternion.multiply(
      shake.setFromAxisAngle(
        axis.set(1, 0, 0),
        (this.slip.y + shimmer(7.1, 13.3)) * frame
      )
    );
    out.quaternion.multiply(
      shake.setFromAxisAngle(
        axis.set(0, 1, 0),
        -(this.slip.x + shimmer(8.3, 11.9)) * frame
      )
    );

    out.aim
      .set(0, 0, -IMPOSTOR_DISTANCE)
      .applyQuaternion(out.quaternion)
      .add(out.position);

    return out;
  }

  /**
   * The mount, sprung toward a little behind the satellite (going `fov`
   * degrees' worth of frame from `direction` now), kicked now and then;
   * and the stars' drift, the other way to it.
   */
  private track(now: number, direction: Vector3, fov: number, delta: number) {
    const next =
      this.satellite && this.swing === 1 && sight(this.satellite, now + 1000);

    let speed = 0;
    way.set(0, 0);

    if (next) {
      // Across the frame, as the telescope's turned to it.
      motion
        .set(...next.direction)
        .sub(direction)
        .applyQuaternion(inverse.copy(sky).invert());
      way.set(motion.x, motion.y);
      const rate = way.length() / (fov * RAD);
      speed = STARS_MAX * (1 - Math.exp(-rate / STARS_MAX));

      if (way.lengthSq() > 0) way.normalize();
    }

    this.drift.copy(way).multiplyScalar(-speed);

    const dt = Math.min(delta, 0.1);
    this.untilKick -= dt;

    if (this.untilKick <= 0) {
      const angle = this.random() * Math.PI * 2;
      const kick = KICK * (0.5 + this.random());
      this.slipping.x += Math.cos(angle) * kick;
      this.slipping.y += Math.sin(angle) * kick;
      this.untilKick = KICKS[0] + (KICKS[1] - KICKS[0]) * this.random();
    }

    const w = 2 * Math.PI * MOUNT_HZ;
    // Toward a little behind it, the faster it's going the more.
    pull
      .copy(way)
      .multiplyScalar((-LAG * speed) / STARS_MAX)
      .sub(this.slip);
    this.slipping.multiplyScalar(1 - 2 * MOUNT_DAMPING * w * dt);
    this.slipping.addScaledVector(pull, w * w * dt);
    this.slip.addScaledVector(this.slipping, dt);
  }
}

/** The one scope: the scene's controls drive it, the telescope watches it. */
export const scope = new Scope();

/** The satellites to follow, as the sky layer has them. */
let satellites = new Map<number, Satellite>();

export function setSatellites(list: Satellite[]) {
  satellites = new Map(list.map((satellite) => [satellite.id, satellite]));
}

export const satelliteFor = (id: string) => satellites.get(Number(id)) ?? null;

const listeners = new Set<() => void>();
let active = false;

/** Whether it's watching, for mounting the telescope only then. */
export function subscribeActive(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export const getActive = () => active;

/** Tells those listening whether it's watching, when that changes. */
export function announce() {
  if (scope.active === active) return;
  active = scope.active;

  for (const listener of listeners) listener();
}

/** The long lens's dark edges: faded by hand each frame, not by React. */
let vignette: HTMLElement | null = null;
let drawn = 0;

export function setVignette(element: HTMLElement | null) {
  vignette = element;
  drawn = 0;
}

/** The vignette's opacity, from the scope. */
export function drawVignette() {
  const opacity = Math.round(scope.vignette * 1000) / 1000;

  if (!vignette || opacity === drawn) return;
  drawn = opacity;
  vignette.style.opacity = String(opacity);
}
