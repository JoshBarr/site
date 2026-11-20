import { Color, PerspectiveCamera, Vector3 } from "three/webgpu";
import { float, max, mix, sin, smoothstep, time, uniform } from "three/tsl";
import { sunIntensity } from "../environment";
import type { PlacedTower } from "./network";
import { SPECS, type TowerSpec } from "./towers";

// Click a pylon and the grid lights up: every tower, wire and cable glowing
// orange, the light running out along the lines from the one clicked and
// pulsing gently after. Click any pylon again and it goes dark.
//
// Lit, it shows what it's carrying (./flow.ts): each line as bright as its
// substations are loaded, and the HVDC link's pulses running the way it's
// sending, the faster the more. At night those run dimly unlit, too.

/** The glow: the orange of a bar fire. */
const COLOUR = new Color("#ff6a12");

/** How bright, against a sunlit hillside and against the dark. */
const BY_DAY = 2.2;
const BY_NIGHT = 1.5;

/** Lit, a part's own colour is this much darker. */
const DIMS = 0.8;

/** The light takes this long to reach the furthest tower, s. */
const SPREAD = 1.6;

/** Its leading edge comes up over this far, m. */
const FRONT = 1200;

/** Further than anything on the map is from anything else, m. */
const REACHED = 200_000;

/** Going dark, and coming back when clicked on the way, s. */
const FADE = 0.5;

/** The pulse: this much brighter and dimmer, a crest every LENGTH m and PERIOD s. */
const PULSE = 0.2;
const PULSE_LENGTH = 5000;
const PULSE_PERIOD = 2.4;

/** Lit, a line carrying nothing is this bright, against 1 at its most. */
const IDLE_LINE = 0.3;

/**
 * The HVDC link's pulses: a head every LINK_LENGTH m along it, one passing
 * every LINK_PERIOD s when it's sending all it can, and slower in
 * proportion. Each comes up over LINK_HEAD of that length and trails off
 * behind over the rest, as the LINK_TAIL power: which way they're going
 * shows even held still.
 */
const LINK_LENGTH = 6000;
const LINK_PERIOD = 1.5;
const LINK_HEAD = 0.04;
const LINK_TAIL = 2;

/**
 * Lit, the link's this bright between pulses and this much more at a
 * pulse's head; all of it this much dimmer sending nothing.
 */
const LINK_REST = 0.35;
const LINK_SURGE = 1.6;
const LINK_IDLE = 0.4;

/**
 * Unlit, its pulses still show along the wires and cables at night: this
 * bright at their heads.
 */
const LINK_NIGHT = 0.6;

/** Pixels from a tower that a click still picks it, however thin it's drawn. */
const REACH = 10;

/**
 * Where the light is: out from `origin` as far as `front`, m, and at
 * `level` of its strength, 0..1.
 */
export const light = {
  origin: uniform(new Vector3()),
  front: uniform(0),
  level: uniform(0),
};

/**
 * What the HVDC link's carrying: whether it's `known` (0 or 1), which way
 * (`heading`: 1 toward `haywards`, north; -1 away), how much of what it can
 * (`transfer`, 0..1), and how far its pulses have `travel`led, in their own
 * lengths. `night` is how bright they show unlit at night: 0 turns that off.
 */
export const link = {
  haywards: uniform(new Vector3()),
  known: uniform(0),
  heading: uniform(1),
  transfer: uniform(0),
  travel: uniform(0),
  night: uniform(LINK_NIGHT),
};

/** Where the link's northern end is: its pulses run to or from it. */
export function placeLink(x: number, y: number, z: number) {
  link.haywards.value.set(x, y, z);
}

/** What the link's sending, and which way; null when it's not known. */
export function setLink(sending: { heading: 1 | -1; transfer: number } | null) {
  link.known.value = sending ? 1 : 0;
  link.heading.value = sending?.heading ?? 1;
  link.transfer.value = sending?.transfer ?? 0;
}

let on = false;

/** How fast the front runs, m/s: by how far it has to go. */
let speed = 0;

let standing: PlacedTower[] = [];

/** The towers that can be clicked, until what's returned is called. */
export function standTowers(towers: PlacedTower[]) {
  standing = towers;

  return () => {
    if (standing === towers) standing = [];
  };
}

/**
 * Lights the grid from `tower` out, or puts it out. Lit again before it's
 * gone dark, it comes back as it was, not from the tower.
 */
export function toggleGrid(tower: PlacedTower) {
  on = !on;

  if (!on || light.level.value > 0) return;

  const [x, y, z] = tower.position;
  light.origin.value.set(x, y + tower.height / 2, z);
  light.front.value = 0;

  const furthest = Math.max(
    ...standing.map(({ position }) =>
      Math.hypot(position[0] - x, position[2] - z)
    )
  );

  speed = (furthest + FRONT) / SPREAD;
}

/** Whether the grid's lit, or being lit. */
export const gridLit = () => on;

/** Moves the light on by `delta` s. Once a frame. */
export function stepGrid(delta: number) {
  const { front, level } = light;

  // The link's pulses run on, lit or not: they show at night regardless.
  link.travel.value =
    (link.travel.value + (delta * link.transfer.value) / LINK_PERIOD) % 1;

  if (level.value === 0 && !on) return;

  // On past the last tower, and out to sea along the cables.
  front.value = Math.min(front.value + speed * delta, REACHED);
  level.value = Math.min(
    Math.max(level.value + (on ? delta : -delta) / FADE, 0),
    1
  );
}

/** How far through a pulse of the link's a world point is, as bright: 0..1. */
function linkPulse(world) {
  const through = world
    .distance(link.haywards)
    .div(LINK_LENGTH)
    .mul(link.heading)
    .add(link.travel)
    .fract();

  return smoothstep(0, LINK_HEAD, through).mul(
    float(1).sub(through).pow(LINK_TAIL)
  );
}

/**
 * What a part of the grid's carrying: how hard its line's working (`level`,
 * 0 idle to 1 its most), and whether it's the HVDC link's (`link`, 0 or 1),
 * which goes by what the link's sending instead.
 */
interface Carrying {
  level: any;
  link: any;
}

/** Any line, at its most: as the grid's lit when nothing's known. */
const AT_MOST: Carrying = { level: float(1), link: float(0) };

/** The HVDC link's own. */
export const LINK: Carrying = { level: float(1), link: float(1) };

/**
 * How lit the grid is at a world point, on a part `carrying` what it is: 0
 * dark, about 1 lit, pulsing. Unless it only shows `whenLit`, a part of the
 * link's has its pulses run along it at night besides.
 */
export function gridGlow(world, carrying: Carrying = AT_MOST, whenLit = false) {
  const { origin, front, level } = light;
  const away = world.distance(origin);
  const reached = float(1).sub(smoothstep(front.sub(FRONT), front, away));

  const pulse = sin(
    away
      .div(PULSE_LENGTH)
      .sub(time.div(PULSE_PERIOD))
      .mul(Math.PI * 2)
  )
    .mul(PULSE)
    .add(1);

  const line = pulse.mul(mix(IDLE_LINE, 1, carrying.level));

  // The link's lit as any line is until it's known what it's sending.
  const run = linkPulse(world);
  const sending = mix(LINK_IDLE, 1, link.transfer);

  const linked = mix(
    pulse,
    run.mul(LINK_SURGE).add(LINK_REST).mul(sending),
    link.known
  );

  const lit = level.mul(reached).mul(mix(line, linked, carrying.link));

  if (whenLit) return lit;

  const night = float(1).sub(smoothstep(0, 0.2, sunIntensity));

  const running = run
    .mul(run)
    .mul(sending)
    .mul(link.night)
    .mul(night)
    .mul(link.known)
    .mul(carrying.link);

  return max(lit, running);
}

/**
 * What's left of a part's own colour where it's `glow` lit: little, or the
 * daylight on its steel greys the orange.
 */
export function gridDims(glow) {
  return float(1).sub(glow.clamp(0, 1).mul(DIMS));
}

/** The light a part of the grid gives off where it's `glow` lit. */
export function gridLight(glow) {
  return uniform(COLOUR)
    .mul(mix(BY_NIGHT, BY_DAY, sunIntensity.clamp(0, 1)))
    .mul(glow);
}

/** A tower near where the view was clicked. */
export interface TowerSighting {
  tower: PlacedTower;
  /** The point up its middle nearest the click, -1..1 across and up the view. */
  x: number;
  y: number;
  /** That point in front of the camera, along its view axis, m. */
  depth: number;
  /** The tower's width, m. */
  length: number;
}

/** How far a tower's steel reaches either side of its middle, m. */
function halfWidth(spec: TowerSpec) {
  return Math.max(
    spec.form === "frame" ? spec.beam : 0,
    ...spec.arms.map(({ x }) => Math.abs(x))
  );
}

const eye = new Vector3();
const forward = new Vector3();
const ray = new Vector3();
const point = new Vector3();

/**
 * The towers standing near enough the point `x`, `y` (-1..1 across and up
 * the view, as three has it) on a view `height` pixels high to be what was
 * meant: within their own width of it, or `reach` pixels, nearest the point
 * first. Some may be hidden behind hills or buildings.
 */
export function towersAt(
  camera: PerspectiveCamera,
  x: number,
  y: number,
  height: number,
  reach = REACH,
  /** Whether a tower this far off can be made out at all, through the haze. */
  visible: (at: Vector3) => boolean = () => true
): TowerSighting[] {
  // Pixels across a metre one metre away.
  const scale = height / 2 / Math.tan((camera.fov * Math.PI) / 360);

  eye.setFromMatrixPosition(camera.matrixWorld);
  camera.getWorldDirection(forward);
  ray.set(x, y, 0.5).unproject(camera).sub(eye).normalize();

  const near: (TowerSighting & { off: number })[] = [];

  for (const tower of standing) {
    const [bx, by, bz] = tower.position;

    // The nearest the ray through the click comes to the tower's axis: `up`
    // the tower, `out` along the ray.
    const wx = eye.x - bx;
    const wy = eye.y - by;
    const wz = eye.z - bz;
    const along = ray.x * wx + ray.y * wy + ray.z * wz;
    const steep = 1 - ray.y * ray.y;

    const up = Math.min(
      Math.max(
        steep > 1e-6 ? wy + (ray.y * (ray.y * wy - along)) / steep : 0,
        0
      ),
      tower.height
    );

    const out = up * ray.y - along;

    if (out <= 0) continue;
    point.set(bx, by + up, bz);

    const depth =
      (point.x - eye.x) * forward.x +
      (point.y - eye.y) * forward.y +
      (point.z - eye.z) * forward.z;

    if (depth <= camera.near || depth >= camera.far) continue;

    const miss = Math.hypot(
      eye.x + ray.x * out - point.x,
      eye.y + ray.y * out - point.y,
      eye.z + ray.z * out - point.z
    );

    const half = halfWidth(SPECS[tower.kind]);
    const off = (miss / depth) * scale;

    if (miss > Math.max(half, (reach * depth) / scale) || !visible(point)) {
      continue;
    }

    point.project(camera);
    near.push({ tower, x: point.x, y: point.y, depth, length: half * 2, off });
  }

  return near
    .sort((a, b) => a.off - b.off)
    .map(({ tower, x, y, depth, length }) => ({ tower, x, y, depth, length }));
}
