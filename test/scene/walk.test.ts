// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { typing, Walk } from "../../src/components/scene/walk";

/** A second of frames at 60 fps, summed. */
function second(walk: Walk, height: number) {
  const total = { forward: 0, right: 0, turn: 0 };

  for (let i = 0; i < 60; i++) {
    const step = walk.step(1 / 60, height);
    total.forward += step?.forward ?? 0;
    total.right += step?.right ?? 0;
    total.turn += step?.turn ?? 0;
  }

  return total;
}

describe("walking from the keyboard", () => {
  it("only takes the keys that walk", () => {
    const walk = new Walk();

    expect(walk.press("KeyW")).toBe(true);
    expect(walk.press("ArrowLeft")).toBe(true);
    expect(walk.press("ShiftLeft")).toBe(false);
    expect(walk.press("KeyX")).toBe(false);
    expect(walk.step(1 / 60, 100)).not.toBeNull();

    walk.clear();
    walk.step(1, 100);
    expect(walk.step(1 / 60, 100)).toBeNull();
  });

  it("eases up to speed, faster the higher it is, and to a stop", () => {
    const low = new Walk();
    const high = new Walk();
    low.press("KeyW");
    high.press("ArrowUp");

    const near = second(low, 100);
    const far = second(high, 1000);

    expect(near.forward).toBeGreaterThan(160);
    expect(near.forward).toBeLessThan(300);
    expect(far.forward).toBeCloseTo(near.forward * 10);
    expect(near.right).toBe(0);

    low.release("KeyW");
    const stopping = second(low, 100);
    expect(stopping.forward).toBeGreaterThan(0);
    expect(stopping.forward).toBeLessThan(near.forward / 4);
    expect(low.step(1 / 60, 100)).toBeNull();
  });

  it("goes no faster on the diagonal, and Shift slows it", () => {
    const straight = new Walk();
    const diagonal = new Walk();
    const slow = new Walk();
    straight.press("KeyD");
    diagonal.press("KeyS");
    diagonal.press("KeyD");
    slow.press("ShiftRight");
    slow.press("KeyD");

    const across = second(straight, 100).right;
    const { forward, right } = second(diagonal, 100);

    expect(Math.hypot(forward, right)).toBeCloseTo(across);
    expect(forward).toBeLessThan(0);
    expect(second(slow, 100).right).toBeCloseTo(across / 4);
  });

  it("turns left on Q and right on E, and not both", () => {
    const left = new Walk();
    const both = new Walk();
    left.press("KeyQ");
    both.press("KeyQ");
    both.press("KeyE");

    expect(second(left, 100).turn).toBeGreaterThan(0.5);
    expect(both.step(1 / 60, 100)).toBeNull();
  });

  it("leaves typing alone", () => {
    const input = document.createElement("input");
    const select = document.createElement("select");

    expect(typing(input)).toBe(true);
    expect(typing(select)).toBe(true);
    expect(typing(document.body)).toBe(false);
    expect(typing(window)).toBe(false);
  });
});
