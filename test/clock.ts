import { vi } from "vitest";

/** When the tests take place, unless they say otherwise. */
export const NOW = Date.parse("2026-11-02T07:00:20Z");

/** Epoch ms, `seconds` before NOW. */
export const ago = (seconds: number) => NOW - seconds * 1000;

/** Stops the clock at `time`. Timers still run, so requests can time out. */
export function freezeTime(time = NOW) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(time);
}
