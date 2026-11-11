import { beforeEach, describe, expect, it, vi } from "vitest";
import { countersFor, type FrameReport } from "../../src/lib/frames";
import * as framesRoute from "../../src/pages/api/frames";
import { freezeTime } from "../clock";
import { liveTable } from "../fixtures/dynamo";
import { call } from "../next";

// Visits' frame times from the scene, counted by day in the live table.

const REPORT: FrameReport = {
  median: 16.7,
  p95: 33.1,
  tier: "desktop",
  backend: "webgpu",
  width: 2160,
  height: 1350,
  dpr: 2,
};

/** Posts `body`, as JSON or as the text a beacon may send. */
const post = (body: string, type = "application/json") =>
  call(framesRoute, "/", {
    method: "POST",
    headers: { "Content-Type": type },
    body,
  });

/** A report as sent, right or wrong. */
const json = (report: Partial<Record<keyof FrameReport, string | number>>) =>
  JSON.stringify(report);

describe("/api/frames", () => {
  let table: ReturnType<typeof liveTable>;

  beforeEach(() => {
    freezeTime();
    vi.stubEnv("LIVE_TABLE", "scene-live-test");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
    table = liveTable();
  });

  it("adds a visit to the day's counts, bucketed", async () => {
    const response = await post(json(REPORT));

    expect(response.status).toBe(204);
    expect(table.updates).toHaveLength(1);

    const day = table.updates[0].Key.sk.S ?? "";
    const item = table.item("frames", day);

    expect(item?.visits).toEqual({ N: "1" });
    expect(item?.["median:desktop:webgpu:17"]).toEqual({ N: "1" });
    expect(item?.["p95:desktop:webgpu:34"]).toEqual({ N: "1" });
    expect(item?.["megapixels:desktop:3"]).toEqual({ N: "1" });
    expect(item?.["dpr:desktop:2"]).toEqual({ N: "1" });
    expect(item?.expires?.N).toMatch(/^\d+$/);
  });

  it("adds each visit to the same day's counts", async () => {
    await post(json(REPORT));
    await post(json({ ...REPORT, tier: "mobile", backend: "webgl", p95: 120 }));

    const day = table.updates[0].Key.sk.S ?? "";
    const item = table.item("frames", day);

    expect(item?.visits).toEqual({ N: "2" });
    expect(item?.["backend:webgl"]).toEqual({ N: "1" });
    expect(item?.["p95:mobile:webgl:more"]).toEqual({ N: "1" });
  });

  it("takes a beacon's report sent as text", async () => {
    const response = await post(json(REPORT), "text/plain");

    expect(response.status).toBe(204);
    expect(table.updates).toHaveLength(1);
  });

  it("turns away a malformed report and counts nothing", async () => {
    for (const body of [
      json({ ...REPORT, tier: "watch" }),
      json({ ...REPORT, median: -1 }),
      json({ ...REPORT, width: 1.5 }),
      json({ ...REPORT, scale: 2 }),
      json({ median: 16 }),
      "not json",
    ]) {
      const response = await post(body, "text/plain");

      expect(response.status).toBe(400);
    }

    expect(table.updates).toHaveLength(0);
  });

  it("only takes a POST", async () => {
    const response = await call(framesRoute);

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it("keeps nothing that would tell visitors apart", () => {
    const counters = countersFor(REPORT);

    expect(counters).toEqual([
      "visits",
      "tier:desktop",
      "backend:webgpu",
      "kind:desktop:webgpu",
      "median:desktop:webgpu:17",
      "p95:desktop:webgpu:34",
      "megapixels:desktop:3",
      "dpr:desktop:2",
    ]);
  });

  it("counts the scale the scene was drawn at, when it's sent", async () => {
    const response = await post(json({ ...REPORT, scale: 0.7 }));

    expect(response.status).toBe(204);

    const day = table.updates[0].Key.sk.S ?? "";
    const item = table.item("frames", day);

    expect(item?.["scale:desktop:webgpu:0.7"]).toEqual({ N: "1" });
    expect(countersFor({ ...REPORT, scale: 1 })).toContain(
      "scale:desktop:webgpu:1"
    );
  });
});
