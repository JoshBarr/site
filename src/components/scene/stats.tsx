import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { WebGPURenderer } from "three/webgpu";
import { useRenderer } from "./renderer";

// ?stats: three's Inspector (CPU and GPU time for each render and compute
// call, per frame) plus a readout of what each frame draws.

/** How often the readout refreshes, s. */
const READOUT_EVERY = 0.5;

/** The costliest render and compute calls listed, by GPU time. */
const TOP_CALLS = 6;

/** The Inspector's running averages per call, which its types leave out. */
interface CallStats {
  stats?: {
    name: string;
    gpu: number;
    renderTarget?: { width: number; height: number } | null;
  }[];
}

/**
 * Each call's own average GPU time, ms, costliest first, named with its
 * target's size so the shadow maps, reflection and scene pass tell apart.
 */
function costliestCalls(renderer: WebGPURenderer) {
  // SAFETY: under ?stats the inspector is three's Inspector, which keeps
  // statsData (examples/jsm/inspector/Inspector.js); it's only untyped.
  const inspector = renderer.inspector as typeof renderer.inspector & {
    statsData?: Map<string, CallStats>;
  };

  const calls: [string, number][] = [];

  for (const { stats } of inspector.statsData?.values() ?? []) {
    if (!stats?.length) continue;

    const recent = stats.slice(-30);
    const gpu = recent.reduce((sum, s) => sum + s.gpu, 0) / recent.length;
    const { name, renderTarget } = stats[stats.length - 1];

    const size = renderTarget
      ? ` ${renderTarget.width}x${renderTarget.height}`
      : "";

    calls.push([`${name}${size}`, gpu]);
  }

  return calls.sort((a, b) => b[1] - a[1]).slice(0, TOP_CALLS);
}

export const showStats = () =>
  new URLSearchParams(location.search).has("stats");

/**
 * ?off=trees,dof,…: parts left out, to measure what each costs by the frame
 * time it gives back. GPU timestamps can't: on Apple's tiled GPUs a pass's
 * span takes in most of the frame.
 */
export function switchedOff(part: string) {
  return (
    new URLSearchParams(location.search)
      .get("off")
      ?.split(",")
      .includes(part) ?? false
  );
}

/** Hands the renderer to three's Inspector, which then times every call. */
export async function attachInspector(renderer: WebGPURenderer) {
  const { Inspector } = await import("three/addons/inspector/Inspector.js");

  renderer.inspector = new Inspector();
  // Counted across the frame's render calls, and reset by Stats below.
  renderer.info.autoReset = false;
}

/**
 * Marks frames for the Inspector (R3F runs its own loop, not three's, which
 * would), and shows draw calls and triangles summed over every render call
 * in the frame: shadow maps, reflection, scene pass and post.
 */
export function Stats() {
  const renderer = useRenderer();
  const readout = useRef<HTMLDivElement | null>(null);
  const since = useRef(0);

  useEffect(() => {
    const div = document.createElement("div");

    Object.assign(div.style, {
      position: "fixed",
      left: "8px",
      top: "8px",
      zIndex: "10",
      padding: "6px 8px",
      borderRadius: "4px",
      background: "rgba(0, 0, 0, 0.6)",
      color: "#eee",
      font: "11px/1.4 ui-monospace, monospace",
      whiteSpace: "pre",
      pointerEvents: "none",
    });

    document.body.appendChild(div);
    readout.current = div;

    return () => div.remove();
  }, []);

  useFrame((_, delta) => {
    const { render, compute } = renderer.info;
    since.current += delta;

    if (readout.current && since.current >= READOUT_EVERY) {
      since.current = 0;
      readout.current.textContent = [
        `${Math.round(1 / delta)} fps  ${(delta * 1000).toFixed(1)} ms`,
        `renders ${render.frameCalls}  draws ${render.drawCalls}`,
        `triangles ${(render.triangles / 1e6).toFixed(2)} M`,
        `computes ${compute.frameCalls}`,
        "gpu ms, own:",
        ...costliestCalls(renderer).map(
          ([name, gpu]) => `${gpu.toFixed(2).padStart(6)}  ${name}`
        ),
      ].join("\n");
    }

    renderer.info.reset();
    renderer.inspector.begin();
  }, -1e9);

  useFrame(() => renderer.inspector.finish(), 1e9);

  return null;
}
