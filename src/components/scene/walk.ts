/** What each key does: forward, right, turn left. By position, not letter. */
const MOVES = {
  KeyW: [1, 0, 0],
  ArrowUp: [1, 0, 0],
  KeyS: [-1, 0, 0],
  ArrowDown: [-1, 0, 0],
  KeyD: [0, 1, 0],
  ArrowRight: [0, 1, 0],
  KeyA: [0, -1, 0],
  ArrowLeft: [0, -1, 0],
  KeyQ: [0, 0, 1],
  KeyE: [0, 0, -1],
} satisfies Record<string, [number, number, number]>;

const walks = (code: string): code is keyof typeof MOVES => code in MOVES;

const SLOW = new Set(["ShiftLeft", "ShiftRight"]);

/** Seconds to get most of the way up to speed, or to stop. */
const EASE = 0.15;

/** Ground speed is this many times the height above ground, per second. */
const SPEED_PER_HEIGHT = 3;

/** Slowest and fastest across the ground, m/s. */
const SPEED: [number, number] = [60, 10000];

/** Shift goes this many times slower. */
const SLOW_BY = 4;

/** Turning, radians a second. */
const TURN_RATE = Math.PI / 3;

/** Under this much of full speed, it's stopped. */
const STILL = 0.01;

/** How far it goes in a frame: forward and right, m, and turned left, radians. */
export interface Step {
  forward: number;
  right: number;
  turn: number;
}

/** Whether a key pressed here is someone typing, not walking. */
export function typing(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement)
  );
}

/**
 * Walking the camera over the map from the keyboard: WASD or the arrows to
 * move, Q and E to turn, Shift to slow down. It eases up to speed and to a stop,
 * faster the higher it is.
 */
export class Walk {
  private readonly held = new Set<string>();
  private readonly moving = [0, 0, 0];

  /** Holds `code` down. True if it's a key that walks. */
  press(code: string) {
    if (SLOW.has(code)) this.held.add(code);

    if (!walks(code)) return false;
    this.held.add(code);

    return true;
  }

  release(code: string) {
    this.held.delete(code);
  }

  /** Lets go of everything, as when the page loses focus. */
  clear() {
    this.held.clear();
  }

  /** Where to go this frame, `height` m above the ground, or null if still. */
  step(delta: number, height: number): Step | null {
    const want = [0, 0, 0];

    for (const code of this.held) {
      if (walks(code)) MOVES[code].forEach((v, i) => (want[i] += v));
    }

    const ease = 1 - Math.exp(-delta / EASE);
    this.moving.forEach((v, i) => {
      const to = Math.max(-1, Math.min(want[i], 1));
      const next = v + (to - v) * ease;
      this.moving[i] = to === 0 && Math.abs(next) < STILL ? 0 : next;
    });

    const [forward, right, turn] = this.moving;

    if (!forward && !right && !turn) return null;

    // No faster on the diagonal.
    const across =
      Math.hypot(forward, right) /
        Math.max(Math.abs(forward), Math.abs(right)) || 1;

    const slow = [...this.held].some((code) => SLOW.has(code)) ? SLOW_BY : 1;

    const speed =
      (Math.min(Math.max(height * SPEED_PER_HEIGHT, SPEED[0]), SPEED[1]) *
        delta) /
      slow /
      across;

    return {
      forward: forward * speed,
      right: right * speed,
      turn: turn * TURN_RATE * delta,
    };
  }
}
