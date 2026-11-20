import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { parseMessage } from "../../src/lib/signs";
import {
  DOTS_HIGH,
  DOTS_WIDE,
  litDots,
} from "../../src/components/scene/traffic/signs/dots";
import type {
  DirectionFace,
  SignsFile,
  Structure,
} from "../../src/components/scene/traffic/signs/file";
import {
  faceSize,
  type Ground,
  layOutDirection,
  pack,
  place,
  placeAll,
  spread,
} from "../../src/components/scene/traffic/signs/layout";

// The signs along the highways: what the build made of its sources
// (public/roads/signs.json, with scripts/traffic/signs.evidence.json), and
// how the scene sets them up.

interface Carriageway {
  road: string;
  points: number[];
  spans: [number, number, number, number, number][];
}

/** The carriageways of public/roads/roads.json, as far as the signs need them. */
async function loadRoads() {
  const file: { carriageways: Record<string, Carriageway> } = JSON.parse(
    await readFile("public/roads/roads.json", "utf8")
  );

  const roads = new Map(
    Object.entries(file.carriageways).map(([name, c]) => {
      const count = c.points.length / 3;
      const s = [0];

      for (let i = 1; i < count; i++) {
        s.push(
          s[i - 1] +
            Math.hypot(
              c.points[i * 3] - c.points[i * 3 - 3],
              c.points[i * 3 + 1] - c.points[i * 3 - 2]
            )
        );
      }

      const at = (distance: number) => {
        let i = 0;

        while (i < count - 2 && s[i + 1] <= distance) i++;
        const span = c.spans.findLast(([from]) => from <= i)!;
        const length = s[i + 1] - s[i] || 1;
        const t = Math.min(Math.max((distance - s[i]) / length, 0), 1);
        const [e0, n0] = [c.points[i * 3], c.points[i * 3 + 1]];
        const [e1, n1] = [c.points[i * 3 + 3], c.points[i * 3 + 4]];

        return {
          easting: e0 + (e1 - e0) * t,
          northing: n0 + (n1 - n0) * t,
          // The way it runs, east and north.
          te: (e1 - e0) / length,
          tn: (n1 - n0) / length,
          lanes: span[1],
          total: span[2],
          limit: span[4],
        };
      };

      return [name, { length: s[count - 1], at }] as const;
    })
  );

  // The world as the map: x east, z south.
  const ground: Ground = {
    toWorld: (easting, northing) => [easting, -northing],
    at(on, distance) {
      const road = roads.get(on);

      if (!road) return null;
      const { te, tn, limit } = road.at(distance);

      return { y: 0, tx: te, tz: -tn, limit: limit / 3.6 };
    },
  };

  return { roads, ground };
}

describe("the signs built for the highways", () => {
  let file: SignsFile;
  let evidence: Record<string, string[]>;
  let omitted: { what: string; why: string }[];
  let world: Awaited<ReturnType<typeof loadRoads>>;

  beforeAll(async () => {
    file = JSON.parse(await readFile("public/roads/signs.json", "utf8"));
    ({ evidence, omitted } = JSON.parse(
      await readFile("scripts/traffic/signs.evidence.json", "utf8")
    ));
    world = await loadRoads();
  });

  it("each stand on a carriageway there is, within its length", () => {
    expect(file.structures.length).toBeGreaterThan(80);

    for (const { id, on, s, panels } of file.structures) {
      for (const at of [{ on, s }, ...panels]) {
        const road = world.roads.get(at.on);

        expect(road, `${id} on ${at.on}`).toBeDefined();
        expect(at.s, id).toBeGreaterThanOrEqual(0);
        expect(at.s, id).toBeLessThanOrEqual(road!.length);
      }
    }
  });

  it("each have their evidence on record, and no evidence is for a sign that isn't there", () => {
    const ids = file.structures.map(({ id }) => id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(evidence).sort()).toEqual([...ids].sort());

    for (const id of ids) {
      expect(evidence[id].length, id).toBeGreaterThan(0);
      expect(evidence[id][0], id).toMatch(/OSM|NZTA|roads\.json/);
    }

    for (const { what, why } of omitted) {
      expect(what).toBeTruthy();
      expect(why).toBeTruthy();
    }
  });

  it("stand posts on the left verge, by where they're said to be", () => {
    const posts = file.structures.filter(({ kind }) => kind === "post");

    expect(posts.length).toBeGreaterThan(60);

    for (const { id, on, s, a } of posts) {
      const road = world.roads.get(on)!.at(s);
      const [de, dn] = [a[0] - road.easting, a[1] - road.northing];
      const along = de * road.te + dn * road.tn;
      const right = de * road.tn - dn * road.te;
      // Its lanes just past it: a limit often changes where they do.
      const past = world.roads.get(on)!.at(s + 1);
      const kerb = (-past.total * (past.limit > 50 ? 3.5 : 3.2)) / 2;

      expect(Math.abs(along), id).toBeLessThan(2);
      // Off the seal, to the left; a mast no further than the verge is wide.
      expect(right, id).toBeLessThan(kerb - 0.9);
      expect(right, id).toBeGreaterThan(kerb - 12.5);
    }
  });

  it("span gantries across the road, with a leg clear of the lanes they're over", () => {
    const overhead = file.structures.filter(({ kind }) => kind !== "post");

    expect(overhead.length).toBeGreaterThan(15);

    for (const { id, on, s, a, b } of overhead) {
      const road = world.roads.get(on)!.at(s);
      const [de, dn] = [b[0] - a[0], b[1] - a[1]];
      const length = Math.hypot(de, dn);

      expect(length, id).toBeGreaterThan(3);
      expect(length, id).toBeLessThan(50);
      // Nearer square to the road than along it.
      expect(Math.abs(de * road.te + dn * road.tn) / length, id).toBeLessThan(
        0.75
      );
    }
  });

  it("face every sign at the traffic coming, and read left to right from there", () => {
    const placed = placeAll(file, world.ground);

    expect(placed).toHaveLength(file.structures.length);

    file.structures.forEach((structure, k) => {
      const live = structure.panels.filter(
        ({ on }) => world.ground.at(on, 0) !== null
      );

      expect(placed[k].faces).toHaveLength(live.length);

      for (const face of placed[k].faces) {
        const panel = structure.panels.find((p) => p.face === face.face)!;
        const road = world.ground.at(panel.on, panel.s)!;

        expect(Math.hypot(face.nx, face.nz)).toBeCloseTo(1, 5);
        // Its face is toward where the traffic's coming from.
        expect(
          face.nx * road.tx + face.nz * road.tz,
          structure.id
        ).toBeLessThan(-0.6);
        expect(face.y - face.height / 2, structure.id).toBeGreaterThan(1.9);
      }
    });
  });

  it("word direction signs only from destinations on record", () => {
    const panels = file.structures.flatMap(({ id, panels }) =>
      panels.flatMap(({ face }) =>
        face.kind === "direction" ? [{ id, face }] : []
      )
    );

    expect(panels.length).toBeGreaterThan(40);

    for (const { id, face } of panels) {
      expect(face.lines.length, id).toBeGreaterThan(0);

      for (const line of face.lines) {
        expect(line.trim(), id).toBe(line);
        expect(line.length, id).toBeGreaterThan(2);
        // Each destination's in the evidence, as OSM spells it or as put right.
        expect(evidence[id].join("\n"), `${id}: ${line}`).toMatch(
          new RegExp(
            line === "Harbour View"
              ? "Harbour Veiw"
              : line === "Hebden Crescent"
                ? "Hebden Crescenct"
                : line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          )
        );
      }

      for (const ref of face.refs ?? []) expect(ref, id).toMatch(/^SH\d+$/);
    }
  });

  it("post speed limits only where the limit changes to them", () => {
    const limits = file.structures.flatMap(({ id, on, s, panels }) =>
      panels.flatMap(({ face }) =>
        face.kind === "speed" ? [{ id, on, s, limit: face.limit }] : []
      )
    );

    expect(limits.length).toBeGreaterThan(15);

    for (const { id, on, s, limit } of limits) {
      const road = world.roads.get(on)!;

      expect([50, 60, 70, 80, 90, 100, 110], id).toContain(limit);
      expect(road.at(s + 30).limit, id).toBe(limit);
      expect(road.at(s - 30).limit, id).not.toBe(limit);
    }
  });

  it("bind each message sign to NZTA's ids, each id once", () => {
    const ids = file.structures.flatMap(({ panels }) =>
      panels.flatMap(({ face }) => (face.kind === "vms" ? face.ids : []))
    );

    expect(ids.length).toBeGreaterThan(30);
    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) expect(Number.isInteger(id)).toBe(true);
  });
});

/** A flat road running north from the origin at 100 km/h. */
const north: Ground = {
  toWorld: (easting, northing) => [easting, -northing],
  at: (on) => (on === "N" ? { y: 10, tx: 0, tz: -1, limit: 100 / 3.6 } : null),
};

const direction = (face: Partial<DirectionFace> = {}): DirectionFace => ({
  kind: "direction",
  lines: ["Johnsonville", "Khandallah"],
  arrow: "left",
  ...face,
});

describe("a sign set up", () => {
  it("on a post faces back down the road, its board in front of its posts", () => {
    const structure: Structure = {
      id: "exit",
      kind: "post",
      on: "N",
      s: 100,
      a: [-8, 100],
      b: [-8, 100],
      panels: [{ on: "N", s: 100, t: 0, face: direction() }],
    };

    const placed = place(structure, north)!;
    const [face] = placed.faces;

    // Traffic runs north (-z): the sign faces south (+z).
    expect(face.nx).toBeCloseTo(0, 9);
    expect(face.nz).toBeCloseTo(1, 9);
    expect(face.x).toBeCloseTo(-8, 5);
    expect(face.z).toBeGreaterThan(-100);
    expect(face.y - face.height / 2).toBeCloseTo(10 + 2.3, 5);
    // A wide board on two posts, from under the ground to near its top.
    expect(placed.boxes).toHaveLength(2);

    for (const box of placed.boxes) {
      expect(box.y - box.size[1] / 2).toBeLessThan(10);
      expect(box.y + box.size[1] / 2).toBeLessThan(face.y + face.height / 2);
    }
  });

  it("is nowhere when its road isn't", () => {
    expect(
      place(
        {
          id: "lost",
          kind: "post",
          on: "elsewhere",
          s: 0,
          a: [0, 0],
          b: [0, 0],
          panels: [],
        },
        north
      )
    ).toBeNull();
  });

  it("on a gantry hangs square to the beam, clear of the road, a message sign raised over a board it would cover", () => {
    const structure: Structure = {
      id: "gantry",
      kind: "gantry",
      on: "N",
      s: 100,
      a: [-12, 100],
      b: [12, 100],
      panels: [
        {
          on: "N",
          s: 100,
          t: 0.5,
          face: { kind: "vms", ids: [1], size: "large" },
        },
        {
          on: "N",
          s: 100,
          t: 0.4,
          face: direction({ arrow: "ahead", refs: ["SH1"] }),
        },
        {
          on: "N",
          s: 100,
          t: 0.6,
          face: direction({ arrow: "right", refs: ["SH2"] }),
        },
      ],
    };

    const { faces, boxes } = place(structure, north)!;
    const boards = faces.filter(({ face }) => face.kind === "direction");
    const [sign] = faces.filter(({ face }) => face.kind === "vms");

    for (const face of faces) {
      expect(face.nx).toBeCloseTo(0, 9);
      expect(face.nz).toBeCloseTo(1, 9);
      expect(face.y - face.height / 2).toBeGreaterThan(10 + 5);
    }

    // The boards, moved apart to clear each other.
    const [left, right] = boards.sort((a, b) => a.x - b.x);

    expect(right.x - right.width / 2).toBeGreaterThan(left.x + left.width / 2);
    // The message sign's over them, not across them.
    expect(sign.y - sign.height / 2).toBeGreaterThan(left.y + left.height / 2);
    // Two legs, a beam, and two struts under the raised sign.
    expect(boxes).toHaveLength(5);
    expect(Math.max(...boxes.map((box) => box.size[0]))).toBeCloseTo(24, 5);
  });

  it("is bigger over the road than on the verge, and in town smaller", () => {
    const fast = faceSize(direction(), 100 / 3.6);
    const overhead = faceSize(direction(), 100 / 3.6, true);
    const town = faceSize(direction(), 50 / 3.6);

    expect(overhead.width).toBeGreaterThan(fast.width);
    expect(fast.width).toBeGreaterThan(town.width);
    expect(faceSize({ kind: "speed", limit: 100 }, 100 / 3.6).width).toBe(1.2);
    expect(faceSize({ kind: "speed", limit: 50 }, 50 / 3.6).width).toBe(0.9);
  });
});

describe("a direction panel", () => {
  it("has a line for each destination and the street, an arrow on the side it points, and a shield for each highway", () => {
    const layout = layOutDirection(
      direction({ street: "Hawkestone Street", refs: ["SH1", "SH2"] }),
      0.3
    );

    expect(layout.text.map(({ text }) => text)).toEqual([
      "Johnsonville",
      "Khandallah",
      "Hawkestone Street",
    ]);
    expect(layout.text[2].capital).toBeLessThan(layout.text[0].capital);
    expect(layout.shields.map(({ number }) => number)).toEqual(["1", "2"]);
    expect(layout.arrows).toHaveLength(1);
    expect(layout.arrows[0].way).toBe("left");
    // Arrow, then shields, then text, all inside the panel.
    expect(layout.arrows[0].x).toBeLessThan(layout.shields[0].x);
    expect(layout.shields[1].x + layout.shields[1].width).toBeLessThan(
      layout.text[0].x
    );

    for (const { y } of layout.text) {
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(layout.height);
    }
  });

  it("points right from its right-hand end", () => {
    const layout = layOutDirection(direction({ arrow: "right" }), 0.3);

    expect(layout.arrows[0].x).toBeGreaterThan(layout.width * 0.7);
    expect(layout.text[0].x).toBeLessThan(layout.arrows[0].x);
  });

  it("over lanes has an arrow down for each, under its legend", () => {
    const layout = layOutDirection(
      direction({ arrow: "down", lanes: 2, lines: ["Airport", "Seatoun"] }),
      0.45
    );

    expect(layout.arrows.map(({ way }) => way)).toEqual(["down", "down"]);
    expect(layout.arrows[0].x).toBeLessThan(layout.arrows[1].x);

    for (const arrow of layout.arrows) {
      expect(arrow.y).toBeGreaterThan(layout.text.at(-1)!.y);
      expect(arrow.y + arrow.size / 2).toBeLessThan(layout.height);
    }
  });
});

describe("panels along a beam", () => {
  it("stay where they are when they don't overlap", () => {
    expect(
      spread([
        { at: 2, width: 3 },
        { at: 8, width: 3 },
      ])
    ).toEqual([2, 8]);
  });

  it("move apart, evenly, until they clear", () => {
    const [a, b] = spread([
      { at: 5, width: 4 },
      { at: 6, width: 4 },
    ]);

    expect(b - a).toBeCloseTo(4.25, 5);
    expect((a + b) / 2).toBeCloseTo(5.5, 5);
  });

  it("keep their order, whatever order they're given in", () => {
    const at = spread([
      { at: 9, width: 4 },
      { at: 5, width: 4 },
      { at: 7, width: 4 },
    ]);

    expect(at[1]).toBeLessThan(at[2]);
    expect(at[2]).toBeLessThan(at[0]);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(4.25 - 1e-3);
    expect(at[0] - at[2]).toBeGreaterThanOrEqual(4.25 - 1e-3);
  });
});

describe("room in the sheet", () => {
  it("is found for every face without any overlapping or running off the side", () => {
    const sizes = Array.from({ length: 40 }, (_, k) => ({
      width: 60 + ((k * 37) % 300),
      height: 40 + ((k * 53) % 90),
    }));

    const { slots, height } = pack(sizes, 512);

    slots.forEach((slot, k) => {
      expect(slot).toMatchObject(sizes[k]);
      expect(slot.x + slot.width).toBeLessThanOrEqual(512);
      expect(slot.y + slot.height).toBeLessThanOrEqual(height);

      for (const other of slots.slice(k + 1)) {
        const apart =
          slot.x + slot.width <= other.x ||
          other.x + other.width <= slot.x ||
          slot.y + slot.height <= other.y ||
          other.y + other.height <= slot.y;

        expect(apart).toBe(true);
      }
    });
  });
});

/** The lit dots of `message`'s first page, a row a string. */
const lit = (message: string) => {
  const dots = litDots(parseMessage(message)[0]);

  return Array.from({ length: DOTS_HIGH }, (_, row) =>
    [...dots.subarray(row * DOTS_WIDE, (row + 1) * DOTS_WIDE)]
      .map((dot) => (dot ? "#" : "."))
      .join("")
  );
};

describe("a message sign's lamps", () => {
  it("are a grid for four lines of twenty", () => {
    expect([DOTS_WIDE, DOTS_HIGH]).toEqual([123, 38]);
    expect(litDots([])).toHaveLength(123 * 38);
    expect(litDots([]).some(Boolean)).toBe(false);
  });

  it("spell a line in 5 by 7 characters, centred", () => {
    const rows = lit("HI").filter((row) => row.includes("#"));

    // Nine characters' room either side of two, on a sign of twenty.
    const from = 2 + 9 * 6;

    expect(rows.map((row) => row.slice(from, from + 11))).toEqual([
      "#...#..###.",
      "#...#...#..",
      "#...#...#..",
      "#####...#..",
      "#...#...#..",
      "#...#...#..",
      "#...#..###.",
    ]);

    expect(rows.every((row) => !row.slice(0, from).includes("#"))).toBe(true);
    expect(rows.every((row) => !row.slice(from + 11).includes("#"))).toBe(true);
  });

  it("set a travel time's place at the left edge and its minutes at the right", () => {
    const rows = lit("PETONE [jl4]9").filter((row) => row.includes("#"));

    expect(Math.min(...rows.map((row) => row.indexOf("#")))).toBe(2);
    expect(Math.max(...rows.map((row) => row.lastIndexOf("#")))).toBe(
      DOTS_WIDE - 2 - 1
    );
  });

  it("centre the lines up and down, four set tighter than three", () => {
    const first = (message: string) =>
      lit(message).findIndex((row) => row.includes("#"));

    expect(first("A[nl]B[nl]C[nl]D")).toBe(2);
    expect(first("A[nl]B[nl]C")).toBe(4);
    expect(first("A")).toBe(15);
  });

  it("show lower case as capitals, and leave out what they've no character for", () => {
    expect(lit("wgtn")).toEqual(lit("WGTN"));
    expect(lit("~").some((row) => row.includes("#"))).toBe(false);
  });

  it("cut a line too long for the sign, keeping the minutes", () => {
    const rows = lit("A VERY LONG PLACE NAME INDEED [jl4]12");

    expect(rows).toEqual(lit("A VERY LONG PLACE [jl4]12"));
  });
});
