import { describe, expect, it } from "vitest";
import {
  createPontoonGeometry,
  NOZZLE_HEIGHT,
  PONTOON_RADIUS,
} from "../../src/components/scene/fountain/pontoon";
import {
  scheduled,
  tooWindy,
  WIND_LIMIT,
  GUST_FACTOR,
} from "../../src/components/scene/fountain/schedule";

const at = (iso: string) => new Date(iso).getTime();

describe("the fountain's hours", () => {
  it("runs a weekday's four sessions, in Wellington's time", () => {
    // Thursday 26 November 2026, NZDT (UTC+13).
    expect(scheduled(at("2026-11-26T07:29:00+13:00"))).toBe(false);
    expect(scheduled(at("2026-11-26T07:30:00+13:00"))).toBe(true);
    expect(scheduled(at("2026-11-26T08:59:00+13:00"))).toBe(true);
    expect(scheduled(at("2026-11-26T09:00:00+13:00"))).toBe(false);
    expect(scheduled(at("2026-11-26T13:00:00+13:00"))).toBe(true);
    expect(scheduled(at("2026-11-26T15:00:00+13:00"))).toBe(false);
    expect(scheduled(at("2026-11-26T17:00:00+13:00"))).toBe(true);
    expect(scheduled(at("2026-11-26T19:00:00+13:00"))).toBe(false);
    expect(scheduled(at("2026-11-26T22:29:00+13:00"))).toBe(true);
    expect(scheduled(at("2026-11-26T22:45:00+13:00"))).toBe(false);
  });

  it("runs till 11 on a Friday night", () => {
    expect(scheduled(at("2026-11-27T22:45:00+13:00"))).toBe(true);
    expect(scheduled(at("2026-11-27T23:00:00+13:00"))).toBe(false);
  });

  it("runs all day and the evening at the weekend", () => {
    // Saturday 28 and Sunday 29 November.
    expect(scheduled(at("2026-11-28T08:00:00+13:00"))).toBe(false);
    expect(scheduled(at("2026-11-28T11:00:00+13:00"))).toBe(true);
    expect(scheduled(at("2026-11-29T16:29:00+13:00"))).toBe(true);
    expect(scheduled(at("2026-11-29T18:00:00+13:00"))).toBe(false);
    expect(scheduled(at("2026-11-29T22:59:00+13:00"))).toBe(true);
  });

  it("keeps to local time in winter, at UTC+12", () => {
    // Monday 6 July 2026, NZST.
    expect(scheduled(at("2026-07-06T07:45:00+12:00"))).toBe(true);
    expect(scheduled(at("2026-07-06T10:00:00+12:00"))).toBe(false);
  });
});

describe("the fountain's wind sensor", () => {
  it("stops it at 10 knots, gusts allowed for", () => {
    const tripsAt = WIND_LIMIT / GUST_FACTOR;

    expect(tooWindy(tripsAt * 0.99)).toBe(false);
    expect(tooWindy(tripsAt)).toBe(true);
    expect(WIND_LIMIT).toBeCloseTo(5.14, 2);
  });
});

describe("the fountain's pontoon", () => {
  it("floats an octagon with its nozzles on top, all in greys", () => {
    const geometry = createPontoonGeometry();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;

    expect(box.max.y).toBeCloseTo(NOZZLE_HEIGHT, 5);
    expect(box.min.y).toBeLessThan(0);
    expect(Math.max(box.max.x, box.max.z)).toBeLessThanOrEqual(
      PONTOON_RADIUS + 0.02
    );

    const color = geometry.getAttribute("color");

    for (let i = 0; i < color.count; i++) {
      expect(color.getX(i)).toBe(color.getY(i));
      expect(color.getY(i)).toBe(color.getZ(i));
    }
  });
});
