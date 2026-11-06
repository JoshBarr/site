import { PerspectiveCamera, Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { designFor } from "../../src/components/scene/scope/craft";
import {
  HUNT,
  LOWER,
  NARROWEST,
  pose,
  RAISE,
  Scope,
  SWING,
  teleFov,
  ZOOM_IN,
  ZOOM_OUT,
} from "../../src/components/scene/scope/scope";
import {
  type Satellite,
  satellitesFrom,
  sight,
} from "../../src/components/scene/sky/orbits";
import { ROOFS, vantage } from "../../src/components/scene/scope/vantage";
import { CSS, ISS } from "../fixtures/celestrak";

// Following a satellite: down from the view to the ground, up at it through
// a telescope, tracking it, and back onto the view it left.

/** Frames, s. */
const DT = 1 / 60;

/** Tiangong passes nearly overhead, sunlit, around 15:13Z. */
const OVERHEAD = Date.parse("2026-11-04T15:13:00Z");

const [tiangong, iss] = satellitesFrom([CSS, ISS]).sort((a, b) =>
  a.name.startsWith("CSS") ? -1 : b.name.startsWith("CSS") ? 1 : 0
);

const VIEW = new Vector3(100, 300, -200);
const TARGET = new Vector3(-2000, 50, 0);

const started = () => {
  const scope = new Scope();
  scope.begin(VIEW, TARGET, 50, 10);

  return scope;
};

/** Steps `scope` on `seconds` from `from`, posing the camera each frame. */
function run(
  scope: Scope,
  seconds: number,
  wanted: Satellite | null,
  from: number
) {
  const out = pose();
  const looks: Vector3[] = [];
  let time = from;

  for (let t = 0; t < seconds; t += DT) {
    time += DT * 1000;
    scope.step(DT, wanted, time);

    if (!scope.active) break;
    scope.pose(time, DT, out);
    looks.push(new Vector3(0, 0, -1).applyQuaternion(out.quaternion));
  }

  return { out, looks, time };
}

/** The biggest turn from one frame to the next, as a fraction of the lens. */
const lurch = (looks: Vector3[], fov: number) =>
  Math.max(...looks.slice(1).map((v, i) => v.angleTo(looks[i]))) /
  ((fov * Math.PI) / 180);

const toward = (satellite: Satellite, time: number) =>
  new Vector3(...sight(satellite, time)!.direction);

describe("the telescope", () => {
  it("comes down to the ground, turns up to it, then zooms in on it", () => {
    const scope = started();
    const { out, looks, time } = run(scope, LOWER + 0.05, tiangong, OVERHEAD);

    // On the ground, looking up at it, the lens as it was.
    expect(scope.lower).toBe(1);
    expect(out.position.y).toBeCloseTo(10, 6);
    expect(out.position.x).toBe(VIEW.x);
    expect(looks.at(-1)!.angleTo(toward(tiangong, time))).toBeLessThan(1e-3);
    // Just starting to zoom.
    expect(out.fov).toBeCloseTo(50, 1);
    expect(lurch(looks, 50)).toBeLessThan(0.05);

    const zoomed = run(scope, ZOOM_IN + 0.05, tiangong, time);
    const { range } = sight(tiangong, zoomed.time)!;

    // It fills a good part of the frame, and stays near the middle of it:
    // the mount trails it a little, and takes the odd knock.
    expect(scope.zoom).toBe(1);
    expect(zoomed.out.fov).toBeCloseTo(
      teleFov(designFor(tiangong.name).span, range * 1000)
    );
    const off = zoomed.looks.at(-1)!.angleTo(toward(tiangong, zoomed.time));
    expect(off / ((zoomed.out.fov * Math.PI) / 180)).toBeLessThan(0.2);
    // The clouds gone, the edges dark.
    expect(scope.clouds).toBe(0);
    expect(scope.vignette).toBe(1);
  });

  it("tracks it overhead without spinning or losing its way", () => {
    const scope = started();
    const { time } = run(scope, LOWER + ZOOM_IN + 0.1, tiangong, OVERHEAD);
    const out = pose();
    let worst = 0;
    let last: Vector3 | null = null;

    // Through the top of its pass, a frame at a time.
    for (let t = 0; t < 120; t += DT) {
      const now = time + t * 1000;
      scope.step(DT, tiangong, now);
      scope.pose(now, DT, out);
      const right = new Vector3(1, 0, 0).applyQuaternion(out.quaternion);
      const look = new Vector3(0, 0, -1).applyQuaternion(out.quaternion);

      expect(Number.isFinite(out.quaternion.w)).toBe(true);
      expect(look.angleTo(toward(tiangong, now))).toBeLessThan(
        (out.fov * Math.PI) / 180
      );

      // The frame turns about its middle no faster than ROLL.
      if (last) worst = Math.max(worst, right.angleTo(last) / DT);
      last = right;
    }

    expect(worst).toBeLessThan(1.6);
  });

  it("keeps the horizon level when it's not overhead", () => {
    const scope = started();
    const later = OVERHEAD + 150_000;
    const { out } = run(scope, LOWER + 0.1, tiangong, later);
    const right = new Vector3(1, 0, 0).applyQuaternion(out.quaternion);

    expect(sight(tiangong, later)!.elevation).toBeLessThan(70);
    expect(Math.abs(right.y)).toBeLessThan(0.02);
  });

  it("zooms out and goes back onto the view it left", () => {
    const scope = started();
    const { time } = run(scope, LOWER + ZOOM_IN + 1, tiangong, OVERHEAD);
    const back = run(scope, ZOOM_OUT + RAISE + 0.2, null, time);

    expect(scope.active).toBe(false);
    expect(scope.satellite).toBeNull();
    expect(scope.position.toArray()).toEqual(VIEW.toArray());
    expect(scope.target.toArray()).toEqual(TARGET.toArray());
    // Its last frames nearly there.
    const camera = new PerspectiveCamera();
    camera.position.copy(VIEW);
    camera.lookAt(TARGET);
    const view = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(back.looks.at(-1)!.angleTo(view)).toBeLessThan(0.01);
    expect(back.out.fov).toBeCloseTo(50, 6);
  });

  it("goes back up if it's let go on the way down", () => {
    const scope = started();
    const { time } = run(scope, LOWER / 2, tiangong, OVERHEAD);
    const lower = scope.lower;
    run(scope, 0.2, null, time);

    expect(scope.zoom).toBe(0);
    expect(scope.lower).toBeLessThan(lower);
    run(scope, RAISE, null, time);
    expect(scope.active).toBe(false);
  });

  it("zooms out, turns across to the next one and zooms in on that", () => {
    const scope = started();
    const first = run(scope, LOWER + ZOOM_IN + 0.1, tiangong, OVERHEAD);

    const across = toward(tiangong, first.time).angleTo(
      toward(iss, first.time)
    );

    const next = run(scope, ZOOM_OUT + SWING + 0.1, iss, first.time);

    expect(scope.satellite).toBe(iss);
    // Just starting to zoom in again.
    expect(scope.zoom).toBeLessThan(0.05);
    expect(scope.swing).toBe(1);
    expect(next.looks.at(-1)!.angleTo(toward(iss, next.time))).toBeLessThan(
      1e-3
    );

    // Wide by then, and turning evenly, as fast as smootherstep goes.
    const fastest =
      ((across / SWING) * 1.875 * DT * 1.05) / ((50 * Math.PI) / 180);

    expect(lurch(next.looks.slice(-SWING * 60), 50)).toBeLessThan(fastest);
  });

  it("trails it on a sprung mount, the stars going by the other way", () => {
    const scope = started();
    const { time } = run(scope, LOWER + ZOOM_IN + 0.1, tiangong, OVERHEAD);
    const out = pose();
    let biggest = 0;
    let behind = 0;
    let frames = 0;

    for (let t = 0; t < 30; t += DT) {
      const now = time + t * 1000;
      scope.step(DT, tiangong, now);
      scope.pose(now, DT, out);
      biggest = Math.max(biggest, scope.slip.length());

      // The stars stream back the way it's come; the mount aims short of it.
      expect(scope.drift.length()).toBeGreaterThan(0.5);
      expect(scope.drift.length()).toBeLessThan(0.81);
      behind += scope.slip.dot(scope.drift) > 0 ? 1 : 0;
      frames++;
    }

    // Off a little, mostly behind it, and never far.
    expect(biggest).toBeGreaterThan(0.02);
    expect(biggest).toBeLessThan(0.25);
    expect(behind / frames).toBeGreaterThan(0.6);
  });

  it("hunts for focus as it arrives, and again now and then", () => {
    const scope = started();
    const { time } = run(scope, LOWER + ZOOM_IN - 0.5, tiangong, OVERHEAD);

    // Soft partway through the zoom.
    expect(Math.abs(scope.focus)).toBeGreaterThan(0.05);
    const focus: number[] = [];

    for (let t = 0; t < 30; t += DT) {
      scope.step(DT, tiangong, time + t * 1000);
      focus.push(scope.focus);
    }

    // Out, past, and back to sharp, then sharp for a while.
    const arrival = focus.slice(0, (HUNT + 1) * 60);

    expect(Math.max(...arrival)).toBeGreaterThan(0.5);
    expect(Math.min(...arrival)).toBeLessThan(-0.05);
    expect(focus[(HUNT + 1) * 60]).toBe(0);

    // And again, within the half minute.
    const hunts = focus.filter(
      (f, i) => i > 0 && f !== 0 && focus[i - 1] === 0
    ).length;

    expect(hunts).toBeGreaterThanOrEqual(2);
  });

  it("stays put when nothing's wanted", () => {
    const scope = new Scope();
    scope.step(1, null, OVERHEAD);

    expect(scope.active).toBe(false);
  });
});

describe("where the telescope stands", () => {
  const flat = () => 20;

  const up = (elevation: number, x = 1) =>
    new Vector3(x, Math.tan((elevation * Math.PI) / 180), 0).normalize();

  it("stands over the roofs, not down on the ground", () => {
    expect(vantage(0, 0, up(60), flat, 0)).toBe(20 + ROOFS);
    expect(vantage(0, 0, new Vector3(0, 1, 0), flat, 0)).toBe(20 + ROOFS);
    // Over the sea, never under where it floats.
    expect(vantage(0, 0, up(60), () => -5, 400)).toBe(400);
  });

  it("goes up to see over a hill in the way, and only that way", () => {
    // A 400 m ridge 1-1.2 km east.
    const ridge = (x: number) => (x > 1000 && x < 1200 ? 400 : 0);
    const over = vantage(0, 0, up(15), ridge, 0);

    // The line over the ridge's near side, roofs and all.
    const climb = Math.tan((15 * Math.PI) / 180);
    expect(over).toBeGreaterThan(400 + ROOFS - 1200 * climb);
    expect(over).toBeLessThanOrEqual(400 + ROOFS - 1000 * climb + 1);
    // Looking west, away from it: just over the roofs.
    expect(vantage(0, 0, up(15, -1), ridge, 0)).toBe(ROOFS);
  });

  it("goes up from a view under where it stands, and back down to it", () => {
    const scope = new Scope();
    const low = new Vector3(0, 30, 0);
    scope.begin(low, TARGET, 50, 200);
    const { out, time } = run(scope, LOWER + 0.05, tiangong, OVERHEAD);

    expect(out.position.y).toBeCloseTo(200, 6);

    const ys: number[] = [];
    const back = pose();
    let t = time;

    for (let s = 0; s < ZOOM_OUT + RAISE + 0.2; s += DT) {
      t += DT * 1000;
      scope.step(DT, null, t);

      if (!scope.active) break;
      ys.push(scope.pose(t, DT, back).position.y);
    }

    expect(Math.min(...ys)).toBeGreaterThanOrEqual(30);
    expect(ys.at(-1)!).toBeLessThan(32);
  });

  it("eases where it stands, up quicker than down", () => {
    const scope = started();
    scope.settle(110, 0.5);
    const rose = (scope.floor - 10) / 100;
    const high = scope.floor;
    scope.settle(10, 0.5);
    const fell = (high - scope.floor) / (high - 10);

    expect(rose).toBeGreaterThan(0.5);
    expect(rose).toBeLessThan(1);
    expect(fell).toBeGreaterThan(0);
    expect(fell).toBeLessThan(rose / 2);
  });
});

describe("the telescope's lens", () => {
  it("frames the ISS overhead in a few hundredths of a degree", () => {
    const fov = teleFov(designFor("ISS (ZARYA)").span, 420_000);

    expect(fov).toBeGreaterThan(0.015);
    expect(fov).toBeLessThan(0.03);
  });

  it("goes no narrower than NARROWEST", () => {
    expect(teleFov(1, 2_000_000)).toBe(NARROWEST);
  });
});
