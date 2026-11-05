import { PerspectiveCamera, Vector3 } from "three/webgpu";
import { RUNWAY } from "../airport/airfield";
import { Category, getSnapshot, next, subject } from "./store";

// Where the camera goes to follow a vehicle, shot by shot:
//
// - buses, trains and taxiing aircraft from overhead, three-quarters
//   behind and to one side;
// - ships from astern, or circling them slowly when they're stopped;
// - aircraft taking off from just ahead of them and off to one side, as a
//   camera ship would; in the cruise from behind and above; landing, from
//   low behind them, looking past them down the approach.
//
// The camera eases onto each shot as it moves, and flies in an arc from
// one vehicle to the next, or cuts straight there if the store says to.

export type ToWorld = (easting: number, northing: number) => [number, number];

/** Lowest the camera may be at x, z. */
export type FloorAt = (x: number, z: number) => number;

export interface Shot {
  position: Vector3;
  target: Vector3;
  /** Vertical, degrees. */
  fov: number;
}

/** The scene's lens, with nothing followed. */
export const DEFAULT_FOV = 50;

/** Seconds without word of the subject before moving on to another. */
const LOST = 5;

/** Seconds for the camera to settle most of the way onto its shot. */
const SETTLE = 0.8;

/** And its aim, onto the subject. */
const AIM = 0.2;

/** Seconds for the lens to settle. */
const ZOOM = 1;

/** Seconds for the shot to swing most of the way round a turn. */
const TURN: Record<Category, number> = {
  bus: 2.5,
  train: 2.5,
  ship: 4,
  plane: 1.5,
  // Not followed by the rig: the trip to orbit has the camera.
  satellite: 1,
};

/** Moving to a new subject: seconds, at least and at most, and m/s. */
const FLIGHT_MIN = 1.5;
const FLIGHT_MAX = 5;
const FLIGHT_SPEED = 2500;

/** Height of the arc flown, as a fraction of the way, and at most, m. */
const ARC = 0.25;
const ARC_MAX = 1500;

/** Overhead: looking down this steeply, degrees. */
const OVERHEAD_ELEVATION = 38;

/** From this far round from dead ahead, degrees, drifting either way by DRIFT. */
const OVERHEAD_AROUND = 145;
const DRIFT = 20;

/** Seconds for the drift to go back and forth. */
const DRIFT_PERIOD = 60;

/** Slower than this, m/s, a ship is stopped and circled. */
const UNDER_WAY = 0.5;

/** Seconds to circle a stopped ship. */
const ORBIT = 120;

/** On the ground slower than this, m/s, an aircraft is taxiing. */
const TAXI_SPEED = 20;

/** On the ground and gaining speed this fast, m/s², it's taking off. */
const ROLLING = 0.3;

/** Climbing this fast, m/s, it's taking off or going around. */
const CLIMBING = 2;

/** Descending this fast, m/s, it may be landing. */
const DESCENDING = 1;

/** Below this, m, a climb is still the take-off; above, the cruise. */
const CLIMB_OUT = 1500;

/** Descending below this, m, anywhere, it's landing. */
const LOW = 300;

/**
 * Lined up on Wellington's runway, from this far out to TOUCHDOWN past the
 * threshold, m, and this far off the centreline, plus SPLAY of the way out,
 * it's on final.
 */
const FINAL = 12_000;
const TOUCHDOWN = 350;
const FINAL_ACROSS = 600;
const SPLAY = 0.1;
const FINAL_ALIGNED = (25 * Math.PI) / 180;

/** Landing, the shot looks down a glide this steep, radians. */
const GLIDE = (3 * Math.PI) / 180;

/**
 * Hidden behind something (a building, a hill, trees), a shot on the ground
 * lifts toward looking straight down from this high, degrees, and stands
 * off up to LIFT_BACK times as far.
 */
const LIFT_ELEVATION = 78;
const LIFT_BACK = 1.6;

/** Each look that finds it hidden lifts it this much more, of the way up. */
const LIFT_STEP = 0.25;

/**
 * Clear for this long, s, it starts back down, this much of the way a
 * second: slowly, so it doesn't drop straight back behind the same block.
 */
const LIFT_HOLD = 4;
const LIFT_FALL = 0.12;

/** Seconds for the shot to follow the lift. */
const LIFT_EASE = 0.7;

type PlaneMode = "taxi" | "takeoff" | "cruise" | "landing";

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi);

/** How far to ease toward something this frame, settling over `time`. */
const ease = (delta: number, time: number) => 1 - Math.exp(-delta / time);
export const smootherstep = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);

/** Moving `way` m to another shot: seconds to take, and the arc's height. */
export const flightFor = (way: number) => ({
  duration: clamp(FLIGHT_MIN + way / FLIGHT_SPEED, FLIGHT_MIN, FLIGHT_MAX),
  arc: Math.min(way * ARC, ARC_MAX),
});

/** 0..1 from a string, so each vehicle keeps its side. */
function hash(text: string) {
  let h = 2166136261;

  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }

  return (h >>> 0) / 2 ** 32;
}

/** Wellington's runway in world space. */
function runwayIn(toWorld: ToWorld) {
  const [sx, sz] = toWorld(...RUNWAY.south);

  const [ex, ez] = toWorld(
    RUNWAY.south[0] + RUNWAY.axis[0],
    RUNWAY.south[1] + RUNWAY.axis[1]
  );

  const [ax, az] = [ex - sx, ez - sz];

  return {
    south: [sx, sz] as const,
    /** Along runway 34, unit. */
    axis: [ax, az] as const,
    /** Square to it, to the east. */
    across: [-az, ax] as const,
    /** Heading landing 34. */
    course: Math.atan2(ax, -az),
  };
}

type Runway = ReturnType<typeof runwayIn>;

const shot = (): Shot => ({
  position: new Vector3(),
  target: new Vector3(),
  fov: DEFAULT_FOV,
});

const look = new Vector3();
const move = new Vector3();

/**
 * Follows whatever the store says is followed, from what its layer
 * publishes each frame. Run it after the layers have drawn their vehicles,
 * so the shot and the vehicle agree.
 */
export class FollowRig {
  private runway: Runway;
  private key: string | null = null;
  private ready = false;
  private category: Category = "bus";
  /** Left (-1) or right (1): which side shots stand off to. */
  private side = 1;
  /** Seconds following this subject. */
  private time = 0;
  private lost = 0;
  /** The shot's heading, swinging round after the subject's. */
  private heading = 0;
  /** Where the subject was last seen, how long it is, and if it's on the ground. */
  readonly at = new Vector3();
  length = 10;
  ground = true;
  private mode: PlaneMode | null = null;
  /** How far up to lift the shot (0..1), what it's at, and seconds clear. */
  private lift = 0;
  private lifted = 0;
  private clear = 0;
  /** On the shot, eased. */
  private rig = shot();
  private wanted = shot();
  /** Where the move onto this subject started, and how far into it. */
  private from = shot();
  private flight = 0;
  private duration = 0;
  private arc = 0;
  /** What the camera's given. */
  readonly shot = shot();

  constructor(
    toWorld: ToWorld,
    private floorAt: FloorAt
  ) {
    this.runway = runwayIn(toWorld);
  }

  /**
   * Lets go of the subject without a shot, so the next one (even the same
   * one again) starts afresh.
   */
  release() {
    this.key = null;
    subject.fresh = false;
  }

  /** Whether the subject's been seen since it was picked. */
  get tracking() {
    return this.ready;
  }

  /**
   * Whether it's still on its way to the subject: not seen yet, or flying
   * in. Hands off it till it's there.
   */
  get arriving() {
    return !this.ready || (!getSnapshot().cut && this.flight < this.duration);
  }

  /** Radians clockwise from north, the way the shot's facing the subject. */
  get facing() {
    return this.heading;
  }

  /**
   * Whether the subject was hidden from the camera when last looked at, so
   * shots on the ground lift over whatever was in the way.
   */
  hidden(hidden: boolean, since: number) {
    if (hidden) {
      this.lift = Math.min(this.lift + LIFT_STEP, 1);
      this.clear = 0;

      return;
    }

    this.clear += since;

    if (this.clear > LIFT_HOLD) {
      this.lift = Math.max(this.lift - LIFT_FALL * since, 0);
    }
  }

  /** The shot for this frame, or null with nothing followed. */
  update(camera: PerspectiveCamera, delta: number): Shot | null {
    const { following, cut } = getSnapshot();

    if (!following) {
      this.release();

      return null;
    }

    const key = `${following.category}:${following.id}`;

    if (key !== this.key) {
      this.key = key;
      this.ready = false;
      this.category = following.category;
      this.side = hash(following.id) < 0.5 ? -1 : 1;
      this.time = this.lost = 0;
      this.lift = this.lifted = this.clear = 0;
      this.mode = null;
      this.from.position.copy(camera.position);
      camera.getWorldDirection(look);
      this.from.target.copy(camera.position).add(look);
      this.from.fov = camera.fov;
      this.shot.position.copy(this.from.position);
      this.shot.target.copy(this.from.target);
      this.shot.fov = this.from.fov;
    }

    if (!subject.fresh) {
      // Gone: off the map, or out of its data. Hold, then try another.
      this.lost += delta;

      if (this.lost > LOST) next();

      return this.shot;
    }

    subject.fresh = false;
    this.lost = 0;
    this.length = subject.length;
    this.ground = subject.ground;

    if (!this.ready) {
      this.ready = true;
      this.at.set(subject.x, subject.y, subject.z);
      this.heading = subject.heading;
      // Still looking the way it was, as far off as the subject.
      look.subVectors(this.from.target, this.from.position);
      this.from.target
        .copy(this.from.position)
        .addScaledVector(look, this.from.position.distanceTo(this.at));
      this.aim();
      this.rig.position.copy(this.wanted.position);
      this.rig.target.copy(this.wanted.target);
      this.rig.fov = this.wanted.fov;
      this.flight = 0;
      ({ duration: this.duration, arc: this.arc } = flightFor(
        this.from.position.distanceTo(this.rig.position)
      ));
    } else {
      this.time += delta;
      move.set(subject.x, subject.y, subject.z).sub(this.at);
      this.at.add(move);
      this.heading +=
        wrap(subject.heading - this.heading) * ease(delta, TURN[this.category]);
      this.lifted += (this.lift - this.lifted) * ease(delta, LIFT_EASE);
      this.aim();
      // Carried along with it, then eased onto the shot.
      this.rig.position.add(move);
      this.rig.target.add(move);
      this.rig.position.lerp(this.wanted.position, ease(delta, SETTLE));
      this.rig.target.lerp(this.wanted.target, ease(delta, AIM));
      this.rig.fov += (this.wanted.fov - this.rig.fov) * ease(delta, ZOOM);
    }

    const { position } = this.rig;
    position.y = Math.max(position.y, this.floorAt(position.x, position.z));

    // Flying in from where the camera was, over the top, unless cutting.
    const out = this.shot;

    if (!cut && this.flight < this.duration) {
      this.flight += delta;
      const u = Math.min(this.flight / this.duration, 1);
      const s = smootherstep(u);
      out.position.lerpVectors(this.from.position, this.rig.position, s);
      out.position.y += this.arc * Math.sin(Math.PI * s);
      // Turning to it in the first half.
      out.target.lerpVectors(
        this.from.target,
        this.rig.target,
        smootherstep(Math.min(u * 2, 1))
      );
      out.fov = this.from.fov + (this.rig.fov - this.from.fov) * s;
      out.position.y = Math.max(
        out.position.y,
        this.floorAt(out.position.x, out.position.z)
      );
    } else {
      out.position.copy(this.rig.position);
      out.target.copy(this.rig.target);
      out.fov = this.rig.fov;
    }

    return out;
  }

  /** Sets `wanted` for this frame, lifted if it's been hidden. */
  private aim() {
    this.frame();

    if (!subject.ground || this.lifted < 1e-3) return;

    // Swung up about it, toward overhead, and further off.
    const { position } = this.wanted;
    const dx = position.x - subject.x;
    const dz = position.z - subject.z;
    const across = Math.hypot(dx, dz);
    const up = position.y - subject.y;
    const elevation = Math.atan2(up, across);

    const lifted =
      elevation + (radians(LIFT_ELEVATION) - elevation) * this.lifted;

    if (lifted <= elevation) return;

    const distance =
      Math.hypot(across, up) * (1 + (LIFT_BACK - 1) * this.lifted);

    const flat = (distance * Math.cos(lifted)) / (across || 1);

    position.set(
      subject.x + (across ? dx * flat : 0),
      subject.y + distance * Math.sin(lifted),
      subject.z + (across ? dz * flat : 0)
    );
  }

  /** Sets `wanted` for this frame, for what it's doing. */
  private frame() {
    const h = this.heading;

    switch (this.category) {
      case "bus":
      case "train":
        return this.overhead(h);
      case "ship":
        return this.astern(h);
      case "plane": {
        this.mode = this.planeMode(this.mode);

        if (this.mode === "taxi") return this.overhead(h);

        if (this.mode === "takeoff") return this.alongside(h, 1);

        if (this.mode === "cruise") return this.alongside(h, -1);

        return this.approach(h);
      }
    }
  }

  /** Three-quarters from behind, to one side, looking down. */
  private overhead(h: number) {
    const size = Math.max(subject.length, 10);
    const distance = 1.8 * size + 50;
    const elevation = radians(OVERHEAD_ELEVATION);
    const drift = DRIFT * Math.sin((this.time * 2 * Math.PI) / DRIFT_PERIOD);
    const bearing = h + radians(OVERHEAD_AROUND + drift) * this.side;
    const flat = distance * Math.cos(elevation);
    this.wanted.position.set(
      subject.x + Math.sin(bearing) * flat,
      subject.y + distance * Math.sin(elevation),
      subject.z - Math.cos(bearing) * flat
    );
    // A little ahead of it, the way it's going.
    this.wanted.target.set(
      subject.x + Math.sin(h) * size * 0.3,
      subject.y,
      subject.z - Math.cos(h) * size * 0.3
    );
    this.wanted.fov = 40;
  }

  /** From astern and above, looking past it; stopped, circling it. */
  private astern(h: number) {
    const size = Math.max(subject.length, 8);
    const underWay = subject.speed > UNDER_WAY;

    const bearing = underWay
      ? h + Math.PI
      : h + Math.PI + (this.time * 2 * Math.PI) / ORBIT;

    const back = clamp(2 * size + 40, 50, 700);
    const up = clamp(0.35 * size + 12, 10, 150);
    const ahead = underWay ? size * 0.6 : 0;
    this.wanted.position.set(
      subject.x + Math.sin(bearing) * back,
      subject.y + up,
      subject.z - Math.cos(bearing) * back
    );
    this.wanted.target.set(
      subject.x + Math.sin(h) * ahead,
      subject.y + size * 0.05,
      subject.z - Math.cos(h) * ahead
    );
    this.wanted.fov = 45;
  }

  /**
   * Flying with it, off to one side: `lead` 1 ahead and level, looking
   * back at it, as off a camera ship on a take-off; -1 behind and above.
   */
  private alongside(h: number, lead: 1 | -1) {
    const size = Math.max(subject.length, 10);
    const f = [Math.sin(h), -Math.cos(h)];
    const r = [Math.cos(h), Math.sin(h)];
    const along = lead > 0 ? 2.5 * size + 20 : -(3 * size + 30);
    const across = (lead > 0 ? 2 * size + 20 : 1.5 * size + 20) * this.side;
    const up = lead > 0 ? 0.3 * size : 0.6 * size + 10;
    this.wanted.position.set(
      subject.x + f[0] * along + r[0] * across,
      subject.y + up,
      subject.z + f[1] * along + r[1] * across
    );
    const ahead = lead > 0 ? 0 : size;
    this.wanted.target.set(
      subject.x + f[0] * ahead,
      subject.y,
      subject.z + f[1] * ahead
    );
    this.wanted.fov = lead > 0 ? 40 : 45;
  }

  /**
   * Low behind it and a little to one side, looking past it down the glide,
   * so the runway comes up to meet it.
   */
  private approach(h: number) {
    const size = Math.max(subject.length, 10);
    const f = [Math.sin(h), -Math.cos(h)];
    const r = [Math.cos(h), Math.sin(h)];
    const back = 2.5 * size + 25;
    const across = (0.8 * size + 10) * this.side;
    this.wanted.position.set(
      subject.x - f[0] * back + r[0] * across,
      subject.y + 0.25 * size + 5,
      subject.z - f[1] * back + r[1] * across
    );
    const ahead = 4 * size;
    this.wanted.target.set(
      subject.x + f[0] * ahead,
      subject.y - ahead * Math.tan(GLIDE),
      subject.z + f[1] * ahead
    );
    this.wanted.fov = 45;
  }

  /** Whether it's on final for Wellington's runway. */
  private onFinal() {
    const { south, axis, across, course } = this.runway;
    const dx = subject.x - south[0];
    const dz = subject.z - south[1];
    const along = dx * axis[0] + dz * axis[1];
    const off = Math.abs(dx * across[0] + dz * across[1]);
    const north = Math.cos(subject.heading - course) > 0;

    const angle = Math.abs(
      wrap(subject.heading - course - (north ? 0 : Math.PI))
    );

    const out = north ? RUNWAY.threshold34 - along : along - RUNWAY.threshold16;

    return (
      angle < FINAL_ALIGNED &&
      out > -TOUCHDOWN &&
      out < FINAL &&
      off < FINAL_ACROSS + out * SPLAY
    );
  }

  /** What it's doing, from what it was doing. */
  private planeMode(mode: PlaneMode | null): PlaneMode {
    const { ground, speed, climb, accel, height } = subject;

    if (ground) {
      if (speed < TAXI_SPEED) return "taxi";

      if (mode === "landing" || mode === "takeoff") return mode;

      // Down without being seen coming in.
      if (mode === "cruise") return "landing";

      return accel > ROLLING ? "takeoff" : "taxi";
    }

    if (mode === "landing") return climb > CLIMBING * 2 ? "cruise" : mode;

    if (
      mode === "takeoff" ||
      ((mode === null || mode === "taxi") &&
        climb > CLIMBING &&
        height < CLIMB_OUT)
    ) {
      return height < CLIMB_OUT && climb > -DESCENDING ? "takeoff" : "cruise";
    }

    if (climb < -DESCENDING && (height < LOW || this.onFinal())) {
      return "landing";
    }

    return "cruise";
  }
}
