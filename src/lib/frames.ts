import { z } from "zod";

// How fast the scene draws for those who see it: one report a visit, from
// the scene (src/components/scene/frames.ts), counted by day into the live
// table (src/pages/api/frames.ts). Nothing in it says who sent it: no ids,
// no user agent, no address, no GPU, and the numbers are bucketed before
// they're kept.

/** One visit's report, as the scene sends it. */
export const frameReport = z.object({
  /** Median and 95th-percentile time between frames, ms. */
  median: z.number().min(1).max(10_000),
  p95: z.number().min(1).max(10_000),
  /** The scene's quality tier: phones and tablets get the lighter one. */
  tier: z.enum(["mobile", "desktop"]),
  /** WebGPU, or the WebGL 2 fallback (a flat sea, no wind). */
  backend: z.enum(["webgpu", "webgl"]),
  /** The canvas's drawing buffer, device pixels. */
  width: z.int().min(1).max(16_384),
  height: z.int().min(1).max(16_384),
  /** The screen's device pixel ratio. */
  dpr: z.number().min(0.25).max(8),
});

export type FrameReport = z.infer<typeof frameReport>;

/** Frame time buckets, ms, by their upper bounds: 120, 90, 60, 30 fps… */
const INTERVALS = [9, 12, 17, 21, 25, 34, 50, 67, 100];

/** Drawing buffer buckets, megapixels, by their upper bounds. */
const MEGAPIXELS = [0.5, 1, 2, 3, 4, 6, 9];

/** The upper bound of the first of `bounds` holding `value`, or "more". */
function bucket(value: number, bounds: number[]) {
  const bound = bounds.find((b) => value <= b);

  return bound === undefined ? "more" : String(bound);
}

/** The report's counters to add one to, as the table keeps them. */
export function countersFor(report: FrameReport) {
  const { tier, backend } = report;
  const kind = `${tier}:${backend}`;
  const megapixels = (report.width * report.height) / 1e6;
  // To the nearest quarter: 1, 1.25, 1.5, 2, 3…
  const dpr = Math.round(report.dpr * 4) / 4;

  return [
    "visits",
    `tier:${tier}`,
    `backend:${backend}`,
    `kind:${kind}`,
    `median:${kind}:${bucket(report.median, INTERVALS)}`,
    `p95:${kind}:${bucket(report.p95, INTERVALS)}`,
    `megapixels:${tier}:${bucket(megapixels, MEGAPIXELS)}`,
    `dpr:${tier}:${dpr}`,
  ];
}

/** The day a report's counted in, as the sort key: Wellington's date. */
export function dayOf(time: number) {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
  }).format(time);
}

/** The table's partition for the counts. */
export const FRAMES_PK = "frames";

/** Counts are kept this long, s. */
export const FRAMES_TTL = 400 * 24 * 3600;
