import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { fetchMeanLevel, fetchTide } from "../../src/lib/tide";
import { ago } from "../clock";
import { server } from "../msw";

// The Queens Wharf tide gauge, through Tilde: its 30-day mean, and the
// newest half hour's minutes, read into how high the harbour is and how
// fast it's moving.

const SERIES =
  "https://tilde.geonet.org.nz/v4/data/coastal/WLGT/water-height/40/15s/nil/latest/:period";

/** Tilde's timestamps: whole seconds, no milliseconds. */
const ts = (time: number) => new Date(time).toISOString().replace(".000", "");

/** Tilde answering with `data` for each period, asked as it says. */
function tilde(data: Record<string, { val: number | null; ts: string }[]>) {
  const asked: string[] = [];

  server.use(
    http.get(SERIES, ({ params, request }) => {
      const { searchParams } = new URL(request.url);
      const period = String(params.period);

      asked.push(
        `${period} ${searchParams.get("aggregationPeriod")} ${searchParams.get("aggregationFunction")}`
      );

      return HttpResponse.json([
        {
          series: {},
          data: (data[period] ?? []).map((d) => ({ ...d, err: 0, qc: "" })),
        },
      ]);
    })
  );

  return asked;
}

/** The last `count` minutes, each `level(minutesAgo)` metres on the gauge. */
const minutes = (count: number, level: (minutesAgo: number) => number | null) =>
  Array.from({ length: count }, (_, i) => {
    const minutesAgo = count - 1 - i;

    return { val: level(minutesAgo), ts: ts(ago(minutesAgo * 60)) };
  });

describe("the tide gauge", () => {
  describe("its 30-day mean", () => {
    it("is the mean of each day's", async () => {
      const asked = tilde({
        "30d": [2.5, 2.7, null, 2.6].map((val, i) => ({
          val,
          ts: `2026-10-0${i + 1}T00:00:00Z`,
        })),
      });

      // The day without a reading isn't counted.
      expect(await fetchMeanLevel()).toBeCloseTo(2.6, 10);
      expect(asked).toEqual(["30d 1d mean"]);
    });

    it("fails without a day measured", async () => {
      tilde({ "30d": [{ val: null, ts: "2026-10-01T00:00:00Z" }] });

      await expect(fetchMeanLevel()).rejects.toThrow("tilde: no days measured");
    });
  });

  describe("the tide now", () => {
    it("is the newest minute over the mean, rising as it's fitted", async () => {
      // Rising 0.6 m an hour, with a wave's chop on alternate minutes.
      const asked = tilde({
        "30m": minutes(
          30,
          (m) => 2.9 - (0.6 * m) / 60 + (m % 2 ? 0.01 : -0.01)
        ),
      });

      const tide = await fetchTide(2.6);

      expect(asked).toEqual(["30m 1m mean"]);

      expect(tide).toEqual({
        time: Date.parse(ts(ago(0))),
        level: 0.29,
        rate: expect.closeTo(0.6, 1),
      });
    });

    it("falls as negative", async () => {
      tilde({ "30m": minutes(10, (m) => 2 + (0.3 * m) / 60) });

      expect(await fetchTide(2.6)).toMatchObject({ level: -0.6, rate: -0.3 });
    });

    it("goes by the minutes measured, skipping those that aren't", async () => {
      tilde({ "30m": minutes(10, (m) => (m === 0 ? null : 2.7)) });

      expect(await fetchTide(2.6)).toEqual({
        time: Date.parse(ts(ago(60))),
        level: 0.1,
        // Flat, give or take rounding.
        rate: expect.closeTo(0, 3),
      });
    });

    it("doesn't move with only one minute measured", async () => {
      tilde({ "30m": minutes(1, () => 3) });

      expect(await fetchTide(2.6)).toMatchObject({ level: 0.4, rate: 0 });
    });

    it("is unknown when the gauge has gone quiet", async () => {
      tilde({ "30m": [] });

      expect(await fetchTide(2.6)).toBeNull();
    });
  });

  describe("fails", () => {
    it("when Tilde does", async () => {
      server.use(
        http.get(SERIES, () => new HttpResponse(null, { status: 504 }))
      );

      await expect(fetchTide(2.6)).rejects.toThrow("tilde: HTTP 504");
    });

    it("when it answers with something else", async () => {
      server.use(http.get(SERIES, () => HttpResponse.json({ data: [] })));

      await expect(fetchMeanLevel()).rejects.toThrow(
        "tilde: unexpected response"
      );
    });
  });
});
