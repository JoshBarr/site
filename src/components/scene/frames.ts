import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { FrameReport } from "../../lib/frames";
import { renderScale } from "./governor";
import { hasFirstViewLoaded } from "./loading";
import { useRenderer } from "./renderer";
import { sceneShown } from "./visibility";

// How fast the scene draws here, sent once a visit (see lib/frames.ts):
// once it's been shown, loaded, for long enough to say. Not from scripts
// driving the browser (the before/after shots), and only in production,
// unless the page asks (?frames).

/** Seconds of frames, shown and loaded, to report on. */
const SAMPLE = 20;

/** Gaps longer than this, s, are the tab coming back, not a frame. */
const LONGEST = 1;

/** Where reports go. */
const URL = "/api/frames";

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

/** Samples the frame loop and sends one report, then stops. */
export function useFrameReport(tier: FrameReport["tier"]) {
  const renderer = useRenderer();
  const intervals = useRef<number[]>([]);
  const elapsed = useRef(0);

  const done = useRef(
    (process.env.NODE_ENV !== "production" &&
      !new URLSearchParams(location.search).has("frames")) ||
      navigator.webdriver ||
      !("sendBeacon" in navigator)
  );

  useFrame((_, delta) => {
    if (done.current) return;

    if (!sceneShown() || !hasFirstViewLoaded() || delta > LONGEST) return;

    intervals.current.push(delta * 1000);
    elapsed.current += delta;

    if (elapsed.current < SAMPLE) return;
    done.current = true;

    const sorted = intervals.current.sort((a, b) => a - b);
    const canvas = renderer.domElement;

    const backend =
      "isWebGPUBackend" in renderer.backend &&
      renderer.backend.isWebGPUBackend === true
        ? "webgpu"
        : "webgl";

    const report: FrameReport = {
      median: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      tier,
      backend,
      width: canvas.width,
      height: canvas.height,
      dpr: window.devicePixelRatio,
      scale: renderScale(),
    };

    navigator.sendBeacon(
      URL,
      new Blob([JSON.stringify(report)], { type: "application/json" })
    );
  });
}
