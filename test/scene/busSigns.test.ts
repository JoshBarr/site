import { describe, expect, it } from "vitest";
import { createBusGeometry } from "../../src/components/scene/buses/model";
import {
  BAND_WIDE,
  BusSigns,
  FRONT_WIDE,
  litBusSign,
  REAR_FROM,
  REAR_WIDE,
  SIGN_ROWS,
} from "../../src/components/scene/buses/sign";

// The signs on a bus drawn in detail: which lamps are lit for a route and
// where it's going, the bands of the map they're kept in, and the faces
// on the model they're drawn on.

/** The lit lamps' bounds in columns `from` to `to` of a band: l, t, r, b. */
function lit(dots: Uint8Array, from: number, to: number) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];

  for (let y = 0; y < SIGN_ROWS; y++) {
    for (let x = from; x < to; x++) {
      if (!dots[y * BAND_WIDE + x]) continue;
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
  }

  return box;
}

/** A band as text, a row a line: for reading a sign that's wrong. */
const drawn = (dots: Uint8Array) =>
  Array.from({ length: SIGN_ROWS }, (_, y) =>
    [...dots.subarray(y * BAND_WIDE, (y + 1) * BAND_WIDE)]
      .map((d) => (d ? "#" : "."))
      .join("")
  ).join("\n");

describe("a bus's sign", () => {
  it("has its number at the right of the front, twice the size", () => {
    const dots = litBusSign("4", "Strathmore Park");
    // A 4's ten lamps across, fourteen down, two in from the edge.
    const number = lit(dots, FRONT_WIDE - 14, FRONT_WIDE);

    expect(number, drawn(dots)).toEqual([
      FRONT_WIDE - 12,
      2,
      FRONT_WIDE - 3,
      15,
    ]);
  });

  it("has its number alone in the middle of the back", () => {
    const dots = litBusSign("83", "Eastbourne");
    const [left, top, right, bottom] = lit(dots, REAR_FROM, BAND_WIDE);

    expect([top, bottom]).toEqual([2, 15]);
    // Two characters and the gap between: 22 lamps, centred.
    expect(right - left + 1).toBe(22);
    expect(left - REAR_FROM).toBe(REAR_FROM + REAR_WIDE - 1 - right);

    // Nothing between the front's lamps and the back's.
    expect(lit(dots, FRONT_WIDE, REAR_FROM)[0]).toBe(Infinity);
  });

  it("says where it's going as big as the number where there's room", () => {
    const dots = litBusSign("2", "Karori");
    const [left, top, right, bottom] = lit(dots, 0, FRONT_WIDE - 16);

    expect([top, bottom]).toEqual([2, 15]);
    // Six characters twice the size: 70 lamps, in the middle of the room
    // left of the number; the I's last column is dark.
    expect(right - left + 1).toBe(70 - 2);
    expect(left).toBe(2 + (FRONT_WIDE - 4 - 14 - 70) / 2);
  });

  it("sets a longer name tall and narrow", () => {
    const dots = litBusSign("4", "Strathmore Park");
    const [left, top, right, bottom] = lit(dots, 0, FRONT_WIDE - 16);

    expect([top, bottom]).toEqual([2, 15]);
    // Fifteen characters, five lamps each and one between: the K's last.
    expect(right - left + 1).toBe(15 * 6 - 1);
  });

  it("puts a name too long for one line on two", () => {
    const dots = litBusSign("60e", "Whitby Navigation Drive");
    const [left, top, right, bottom] = lit(dots, 0, FRONT_WIDE - 40);

    expect([top, bottom]).toEqual([1, 16]);
    // "WHITBY" over "NAVIGATION DRIVE": the longer's 16 characters.
    expect(right - left + 1).toBe(16 * 6 - 1);

    // The gap between the lines is dark.
    expect(
      [8, 9].flatMap((y) => [
        ...dots.subarray(y * BAND_WIDE, y * BAND_WIDE + FRONT_WIDE - 40),
      ])
    ).not.toContain(255);
  });

  it("breaks at a dash, and says the university shorter", () => {
    const long = litBusSign(
      "22",
      "Victoria University of Wellington - Kelburn"
    );

    // "VICTORIA UNI" over "KELBURN".
    const [left, top, right, bottom] = lit(long, 0, FRONT_WIDE - 28);

    expect([top, bottom]).toEqual([1, 16]);
    // Less the I's dark last column.
    expect(right - left + 1).toBe(12 * 6 - 1 - 1);
  });

  it("has long vowels, and a gap for what it has no character for", () => {
    const [, top] = lit(litBusSign("", "Ōtaki"), 0, FRONT_WIDE);

    expect(top).toBe(2);
    expect(lit(litBusSign("", "~"), 0, BAND_WIDE)[0]).toBe(Infinity);
  });

  it("shows the number alone when the timetable has no destination", () => {
    const dots = litBusSign("AX", "");

    expect(lit(dots, 0, FRONT_WIDE - 28)[0]).toBe(Infinity);
    expect(lit(dots, FRONT_WIDE - 28, FRONT_WIDE)[0]).toBeLessThan(FRONT_WIDE);
  });
});

describe("the signs' bands", () => {
  const band = (signs: BusSigns, k: number) =>
    signs.lamps.subarray(
      k * BAND_WIDE * SIGN_ROWS,
      (k + 1) * BAND_WIDE * SIGN_ROWS
    );

  it("keep a sign's band from frame to frame", () => {
    const signs = new BusSigns(4);

    signs.begin();
    const karori = signs.bandFor("2", "Karori");
    const miramar = signs.bandFor("2", "Miramar");

    expect(miramar).not.toBe(karori);
    expect(signs.changed).toBe(true);
    expect(band(signs, karori)).toEqual(litBusSign("2", "Karori"));
    expect(band(signs, miramar)).toEqual(litBusSign("2", "Miramar"));

    signs.changed = false;
    signs.begin();
    expect(signs.bandFor("2", "Karori")).toBe(karori);
    expect(signs.changed).toBe(false);
  });

  it("give up the one longest out of sight for a new one", () => {
    const signs = new BusSigns(2);

    signs.begin();
    const first = signs.bandFor("1", "Island Bay");
    const second = signs.bandFor("3", "Lyall Bay");

    // Only the second's still showing; a third takes the first's.
    signs.begin();
    signs.bandFor("3", "Lyall Bay");
    expect(signs.bandFor("7", "Kingston")).toBe(first);
    expect(band(signs, first)).toEqual(litBusSign("7", "Kingston"));
    expect(signs.bandFor("3", "Lyall Bay")).toBe(second);

    // And the first sign, back in sight, is set up afresh.
    signs.begin();
    signs.bandFor("7", "Kingston");
    expect(signs.bandFor("1", "Island Bay")).toBe(second);
    expect(band(signs, second)).toEqual(litBusSign("1", "Island Bay"));
  });
});

describe("the detailed bus", () => {
  const size = { length: 12.5, width: 2.5, height: 3.2, tint: 0xc4c4c4 };
  const geometry = createBusGeometry(size);
  const position = geometry.getAttribute("position");
  const lamp = geometry.getAttribute("lamp");

  const corners = (z: (z: number) => boolean) =>
    Array.from({ length: position.count }, (_, i) => i)
      .filter((i) => lamp.getZ(i) > 0.5 && z(position.getZ(i)))
      .map((i) => ({
        x: position.getX(i),
        y: position.getY(i),
        u: lamp.getX(i),
        v: lamp.getY(i),
      }));

  it("has a sign's face on its front, read from the left of who's facing it", () => {
    const front = corners((z) => z > 0);

    expect(front).toHaveLength(6);

    for (const { x, y, u, v } of front) {
      // Looking back at the bus, its +x is on the right.
      expect(u).toBeCloseTo(x < 0 ? 0 : FRONT_WIDE, 3);
      expect(v).toBeCloseTo(y > 2.9 ? 0 : SIGN_ROWS, 3);
      // Over the windscreen, under the roof.
      expect(y).toBeGreaterThan(size.height - 0.5);
      expect(y).toBeLessThan(size.height - 0.15);
    }
  });

  it("has one on its back, kerb side, in its own part of the band", () => {
    const rear = corners((z) => z < 0);
    const xs = rear.map(({ x }) => x);

    expect(rear).toHaveLength(6);
    // The kerb's toward +x; from behind, that's the left.
    expect(Math.min(...xs)).toBeGreaterThan(0);

    for (const { x, u } of rear) {
      expect(u).toBeCloseTo(
        x === Math.max(...xs) ? REAR_FROM : REAR_FROM + REAR_WIDE,
        3
      );
    }
  });

  it("marks nothing else as a sign", () => {
    const marked = Array.from({ length: lamp.count }, (_, i) => lamp.getZ(i));

    expect(marked.filter((on) => on > 0.5)).toHaveLength(12);
  });
});
