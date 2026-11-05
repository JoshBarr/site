import { PerspectiveCamera, Vector3 } from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FollowRig,
  Shot,
  ToWorld,
} from "../../src/components/scene/follow/rig";
import {
  followVehicle,
  getSnapshot,
  publish,
  setCut,
  stop,
  Subject,
} from "../../src/components/scene/follow/store";

const ORIGIN = [1751000, 5423000];
const toWorld: ToWorld = (e, n) => [e - ORIGIN[0], -(n - ORIGIN[1])];

/** Frames, s. */
const DT = 1 / 60;

type Pose = Partial<Subject> & Pick<Subject, "x" | "y" | "z">;

let camera: PerspectiveCamera;
let rig: FollowRig;

beforeEach(() => {
  camera = new PerspectiveCamera(50, 1.6, 1, 100_000);
  camera.position.set(0, 800, 3000);
  camera.lookAt(0, 0, 0);
  rig = new FollowRig(toWorld, () => 0);
});

afterEach(() => {
  stop();
  setCut(false);
});

/**
 * `seconds` of frames from `start`, publishing `pose` (when there is one)
 * and putting the camera on each shot, as the scene does. The shots, one a
 * frame.
 */
function run(seconds: number, pose: (t: number) => Pose | null, start = 0) {
  const shots: Shot[] = [];

  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const at = pose(start + i * DT);

    if (at) publish(at);
    const shot = rig.update(camera, DT);

    if (!shot) continue;
    camera.position.copy(shot.position);
    camera.lookAt(shot.target);
    shots.push({
      position: shot.position.clone(),
      target: shot.target.clone(),
      fov: shot.fov,
    });
  }

  return shots;
}

/** A bus heading north up the map (-z) at 10 m/s. */
const bus = (t: number): Pose => ({
  x: 0,
  y: 5,
  z: -10 * t,
  heading: 0,
  length: 12,
  speed: 10,
});

const at = ({ x, y, z }: Pose) => new Vector3(x, y, z);

describe("the follow rig", () => {
  it("lifts over whatever hides a vehicle on the ground, and back down once clear", () => {
    setCut(true);
    followVehicle({ category: "bus", id: "2158", label: "Route 2" });

    const elevation = (shot: Shot, t: number) => {
      const off = shot.position.clone().sub(at(bus(t)));

      return (Math.atan2(off.y, Math.hypot(off.x, off.z)) * 180) / Math.PI;
    };

    const before = run(3, bus).at(-1);

    // Hidden at four looks in a row.
    for (let i = 0; i < 4; i++) rig.hidden(true, 0.25);
    const lifted = run(3, bus, 3).at(-1);

    // Clear, held up a while, then slowly down.
    rig.hidden(false, 2);
    const held = run(1, bus, 6).at(-1);
    rig.hidden(false, 12);
    const after = run(4, bus, 7).at(-1);

    if (!before || !lifted || !held || !after) throw new Error("no shot");
    expect(elevation(lifted, 6)).toBeGreaterThan(elevation(before, 3) + 30);
    // Still up (settling the last of the way), not on its way down.
    expect(elevation(held, 7)).toBeGreaterThanOrEqual(elevation(lifted, 6) - 1);
    expect(elevation(after, 11)).toBeLessThan(elevation(held, 7) - 20);
  });

  it("lets go with nothing followed", () => {
    expect(rig.update(camera, DT)).toBeNull();
  });

  it("cuts onto a bus from overhead, behind it, and carries it along", () => {
    setCut(true);
    followVehicle({ category: "bus", id: "1", label: "1" });
    const shots = run(10, bus);
    const { position, target } = shots.at(-1)!;
    const now = at(bus(10 - DT));

    expect(rig.tracking).toBe(true);
    expect(rig.at.distanceTo(now)).toBeLessThan(1e-6);
    expect(rig.length).toBe(12);
    expect(rig.ground).toBe(true);
    // Above it and behind: north is -z.
    expect(position.y - now.y).toBeGreaterThan(30);
    expect(position.z).toBeGreaterThan(now.z);
    // Aimed just ahead of it.
    expect(target.distanceTo(now)).toBeLessThan(12);

    // Standing off the same way as it goes.
    const before = shots[Math.round(5 / DT)].position.distanceTo(at(bus(5)));
    expect(position.distanceTo(now)).toBeCloseTo(before, 0);
  });

  it("flies in over the top from where the camera was", () => {
    const start = camera.position.clone();
    followVehicle({ category: "bus", id: "2", label: "2" });
    const shots = run(8, bus);

    expect(shots[0].position.distanceTo(start)).toBeLessThan(1);
    // The arc rises above both ends of the way.
    const top = Math.max(...shots.map(({ position }) => position.y));
    expect(top).toBeGreaterThan(start.y);
    expect(shots.at(-1)!.position.distanceTo(at(bus(8)))).toBeLessThan(150);
  });

  it("holds the shot, then moves on, when the subject's lost", () => {
    setCut(true);
    followVehicle({ category: "bus", id: "3", label: "3" });
    run(1, bus);
    const held = run(4, () => null);

    expect(getSnapshot().following).not.toBeNull();
    expect(held.at(-1)!.position.distanceTo(held[0].position)).toBe(0);

    // With nothing else of its kind to go on to, it lets go.
    run(2, () => null);
    expect(getSnapshot().following).toBeNull();
  });

  it("chases a landing from low behind, looking down the glide", () => {
    setCut(true);
    followVehicle({ category: "plane", id: "ANZ1", label: "ANZ1" });

    const landing = (t: number): Pose => ({
      x: 0,
      y: 200 - 4 * t,
      z: -70 * t,
      heading: 0,
      length: 40,
      speed: 70,
      climb: -4,
      ground: false,
      height: 200 - 4 * t,
    });

    const { position, target } = run(5, landing).at(-1)!;
    const now = at(landing(5 - DT));

    expect(rig.ground).toBe(false);
    expect(position.z).toBeGreaterThan(now.z);
    expect(position.y).toBeGreaterThan(now.y);
    expect(position.y - now.y).toBeLessThan(30);
    expect(target.z).toBeLessThan(now.z);
    expect(target.y).toBeLessThan(now.y);
  });

  it("flies ahead of a take-off, looking back at it", () => {
    setCut(true);
    followVehicle({ category: "plane", id: "ANZ2", label: "ANZ2" });

    const climbing = (t: number): Pose => ({
      x: 0,
      y: 50 + 10 * t,
      z: -80 * t,
      heading: 0,
      length: 40,
      speed: 80,
      climb: 10,
      ground: false,
      height: 50 + 10 * t,
    });

    const { position } = run(5, climbing).at(-1)!;

    expect(position.z).toBeLessThan(climbing(5 - DT).z);
  });

  it("circles a ship that's stopped", () => {
    setCut(true);
    followVehicle({ category: "ship", id: "Kaitaki", label: "Kaitaki" });

    const moored = (): Pose => ({ x: 0, y: 0, z: 0, length: 180 });

    // Long enough for the shot to settle round onto the circle.
    const shots = run(40, moored);
    const bearing = ({ position }: Shot) => Math.atan2(position.x, position.z);
    const turned = bearing(shots.at(-1)!) - bearing(shots[Math.round(30 / DT)]);

    // A turn every two minutes.
    expect(Math.abs(turned)).toBeCloseTo((10 / 120) * 2 * Math.PI, 1);
  });
});
