import { describe, expect, it } from "vitest";
import {
  DOTS_HIGH,
  DOTS_WIDE,
  litLane,
} from "../../src/components/scene/traffic/signs/dots";
import {
  estimateLimit,
  speedAt,
} from "../../src/components/scene/traffic/signs/limits";

/** A lane sign's square, as rows of "#" and ".". */
function picture(dots: Uint8Array) {
  return Array.from({ length: DOTS_HIGH }, (_, y) =>
    Array.from({ length: DOTS_HIGH }, (_, x) =>
      dots[y * DOTS_WIDE + x] ? "#" : "."
    ).join("")
  );
}

describe("a lane sign's likely limit", () => {
  it("in the gorge is 80, unless traffic's stopped for a crash", () => {
    expect(estimateLimit("gorge", 85, 1300)).toBe(80);
    expect(estimateLimit("gorge", null, 0)).toBe(80);
    expect(estimateLimit("gorge", 12, 300)).toBe(60);
  });

  it("in the Terrace Tunnel is 70, unless it's very busy", () => {
    expect(estimateLimit("tunnel", 68, 1200)).toBe(70);
    expect(estimateLimit("tunnel", 30, 1200)).toBe(60);
  });

  it("on the motorway drops to 60 in the rush, 80 as it eases, and 100 once it's clear", () => {
    // 7am in: the rush, moving or not.
    expect(estimateLimit("motorway", 90, 1290)).toBe(60);
    // 9am: easing.
    expect(estimateLimit("motorway", 90, 920)).toBe(80);
    // Midday, flowing.
    expect(estimateLimit("motorway", 95, 780)).toBe(100);
    expect(estimateLimit("motorway", null, 780)).toBe(100);
  });

  it("on the motorway drops with the traffic, whatever the hour", () => {
    expect(estimateLimit("motorway", 40, 300)).toBe(60);
    expect(estimateLimit("motorway", 65, 300)).toBe(80);
  });
});

describe("the speed under a lane sign", () => {
  const links: [number, number, string][] = [
    [0, 400, "a"],
    [400, 800, "b"],
    [800, 1200, "c"],
  ];

  const legs: [number, number, string][] = [[0, 5000, "leg"]];
  const road = { links, legs };

  it("is NZTA's links' near it, averaged", () => {
    expect(
      speedAt(road, 500, { links: { a: 60, b: 80, c: 100 }, legs: {} })
    ).toBe(70);
  });

  it("is its leg's where no link near it has a reading, and null with none", () => {
    expect(speedAt(road, 500, { links: { c: 100 }, legs: { leg: 55 } })).toBe(
      55
    );
    expect(speedAt(road, 500, { links: {}, legs: {} })).toBeNull();
    expect(speedAt(road, 500, null)).toBeNull();
  });
});

describe("a lane sign's lamps", () => {
  it("are dark with no limit", () => {
    expect(litLane(null).some(Boolean)).toBe(false);
  });

  it("ring the limit, inside the sign's square", () => {
    const rows = picture(litLane(80));
    const dots = litLane(80);

    // Nothing lit past the square.
    for (let y = 0; y < DOTS_HIGH; y++) {
      for (let x = DOTS_HIGH; x < DOTS_WIDE; x++) {
        expect(dots[y * DOTS_WIDE + x]).toBe(0);
      }
    }

    // The ring: lit at the edges' middles, dark in the corners.
    const middle = DOTS_HIGH / 2;

    expect(rows[middle][1]).toBe("#");
    expect(rows[middle][DOTS_HIGH - 2]).toBe("#");
    expect(rows[1][middle]).toBe("#");
    expect(rows[0][0]).toBe(".");

    // And the number in the middle: something lit, clear of the ring.
    const inside = rows
      .slice(10, 28)
      .map((row) => row.slice(10, 28))
      .join("");

    expect(inside).toContain("#");
  });

  it("fit three figures inside the ring", () => {
    const rows = picture(litLane(100));
    const middle = DOTS_HIGH / 2;

    // Between the ring and the number, a dark gap either side.
    expect(rows[middle].slice(4, 8)).toBe("....");
    expect(rows[middle].slice(DOTS_HIGH - 7, DOTS_HIGH - 4)).toBe("...");
    expect(rows[middle].slice(8, DOTS_HIGH - 7)).toContain("#");
  });
});
