import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Tide } from "../../../lib/tide";
import { layerUrl, sceneNow, useSeek } from "../clock";
import { seaLevel } from "../environment";
import { sceneShown } from "../visibility";

/** /api/tide's gauge is read every five minutes. */
const POLL = 5 * 60_000;

/** A measurement's rate is carried on for this long at most, ms. */
const CARRY = 30 * 60_000;

/** Seconds to ease to a new level, so the shore doesn't jump. */
const EASE = 4;

/** ?tide=0.6, metres above mean sea level, for trying it out. */
function override() {
  const value = new URLSearchParams(location.search).get("tide");
  const level = value === null ? NaN : Number(value);

  return Number.isFinite(level) ? level : null;
}

/** Where the tide's got to at `time` (epoch ms), from the newest measured. */
const levelAt = ({ time: measured, level, rate }: Tide, time: number) =>
  level + (rate * Math.min(Math.max(time - measured, 0), CARRY)) / 3_600_000;

/**
 * Keeps seaLevel (../environment.ts) at the harbour's height at the scene's
 * time (../clock.ts): measured at Queens Wharf, asked for again as it runs
 * on and when it's set, and carried on at its rate between. Mean sea level
 * until it's known.
 */
export function useTide() {
  const seek = useSeek();
  const known = useRef<Tide | null>(null);
  const fixed = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let asked = false;

    const poll = async () => {
      if (sceneShown() || !asked) {
        const url = layerUrl("/api/tide", 60_000);

        asked = true;

        try {
          const response = url ? await fetch(url) : null;

          if (response?.ok && !stopped) known.current = await response.json();
        } catch (e) {
          console.error("[tide]", e);
        }
      }

      if (!stopped) timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [seek]);

  useFrame((_, delta) => {
    if (fixed.current === undefined) fixed.current = override();

    const tide = known.current;

    const target =
      fixed.current ?? (tide ? levelAt(tide, sceneNow()) : seaLevel.value);

    seaLevel.value += (target - seaLevel.value) * (1 - Math.exp(-delta / EASE));
  });
}
