import { describe, expect, it } from "vitest";
import { kakaForm } from "../../src/components/scene/birds/kaka";
import { kereruForm } from "../../src/components/scene/birds/kereru";
import {
  armAt,
  DOWN,
  handAt,
  HELD,
  HELD_HAND,
} from "../../src/components/scene/birds/stroke";

// A wingbeat in two pieces: the arm swinging from the shoulder, and the
// hand bent from it at the wrist, hanging on the way up.

const TURN = Math.PI * 2;

/** The beat, sampled evenly: how far through, the arm, and the hand's bend. */
const beat = Array.from({ length: 200 }, (_, k) => {
  const through = k / 200;

  return {
    through,
    arm: armAt(through * TURN),
    hand: handAt(through * TURN),
  };
});

const down = beat.filter(({ through }) => through < DOWN);
const up = beat.filter(({ through }) => through >= DOWN);

describe("a wingbeat", () => {
  it("comes round to where it began, whatever turn it's on", () => {
    for (const phase of [0.3, 2, 5.1]) {
      for (const turns of [-3, 1, 40]) {
        expect(armAt(phase + turns * TURN)).toBeCloseTo(armAt(phase), 5);
        expect(handAt(phase + turns * TURN)).toBeCloseTo(handAt(phase), 5);
      }
    }
  });

  it("swings the arm down from the top and back, higher than it's low", () => {
    const arms = beat.map(({ arm }) => arm);
    const top = Math.max(...arms);
    const bottom = Math.min(...arms);

    expect(armAt(0)).toBeCloseTo(top, 3);
    expect(armAt(DOWN * TURN)).toBeCloseTo(bottom, 3);
    expect(top).toBeGreaterThan(0.8);
    expect(bottom).toBeLessThan(-0.6);
    expect(top).toBeGreaterThan(-bottom);

    for (let k = 1; k < down.length; k++) {
      expect(down[k].arm).toBeLessThan(down[k - 1].arm);
    }

    for (let k = 1; k < up.length; k++) {
      expect(up[k].arm).toBeGreaterThan(up[k - 1].arm);
    }
  });

  it("takes longer coming up than going down, the fold there to be seen", () => {
    expect(up.length).toBeGreaterThan(down.length);

    // And the hand's hanging, a radian or more below the arm, for nearly
    // a third of the whole beat.
    const hung = beat.filter(({ hand }) => hand < -1).length / beat.length;

    expect(hung).toBeGreaterThan(0.3);
  });

  it("moves without a jump anywhere in it", () => {
    for (let k = 0; k < beat.length; k++) {
      const next = beat[(k + 1) % beat.length];

      expect(Math.abs(next.arm - beat[k].arm)).toBeLessThan(0.05);
      expect(Math.abs(next.hand - beat[k].hand)).toBeLessThan(0.1);
    }
  });

  it("holds the wing out going down, the hand flexed up a little", () => {
    for (const { hand } of down) {
      expect(hand).toBeGreaterThanOrEqual(0);
      expect(hand).toBeLessThan(0.3);
    }
  });

  it("leads with the wrist coming up, the hand hanging from it", () => {
    for (const { hand } of up) expect(hand).toBeLessThanOrEqual(1e-9);

    // Halfway up, the arm's about level and the hand well below it.
    const half = (DOWN + (1 - DOWN) / 2) * TURN;

    expect(Math.abs(armAt(half))).toBeLessThan(0.2);
    expect(armAt(half) + handAt(half)).toBeLessThan(-1.1);

    // And by the top it's flicked out straight again.
    expect(handAt(0.999 * TURN)).toBeGreaterThan(-0.05);
  });

  it("lifts the wingtip later than the wrist", () => {
    // The tip's angle is the arm's and the hand's bend together: on the
    // way up it's lower than the arm throughout, and lowest later.
    const lowest = (of: (step: (typeof beat)[number]) => number) =>
      beat.reduce((low, step) => (of(step) < of(low) ? step : low)).through;

    expect(lowest(({ arm, hand }) => arm + hand)).toBeGreaterThan(
      lowest(({ arm }) => arm) + 0.05
    );
  });

  it("holds its wings out in a glide a little up, the hands a little down", () => {
    expect(HELD).toBeGreaterThan(0);
    expect(HELD).toBeLessThan(0.3);
    expect(HELD_HAND).toBeLessThan(0);
    expect(HELD_HAND).toBeGreaterThan(-0.3);
  });
});

describe("a wing's two pieces", () => {
  it.each([
    ["kākā", kakaForm()],
    ["kererū", kereruForm()],
  ])("split the %s's wing at a wrist, some of it either side", (_, form) => {
    const position = form.geometry.getAttribute("position");
    const part = form.geometry.getAttribute("part");
    const out = form.wrist;
    let arm = 0;
    let hand = 0;
    let on = 0;

    for (let i = 0; i < position.count; i++) {
      if (part.getX(i) !== 1) continue;

      const x = Math.abs(position.getX(i));

      if (x > out + 1e-4) hand++;
      else arm++;

      if (Math.abs(x - out) < 1e-4) on++;
    }

    expect(out).toBeGreaterThan(form.shoulder + 0.1);
    expect(out).toBeLessThan(0.4);
    expect(arm).toBeGreaterThan(0);
    expect(hand).toBeGreaterThan(0);
    // Vertices on the wrist itself, so the bend's a clean line.
    expect(on).toBeGreaterThan(0);
  });
});
