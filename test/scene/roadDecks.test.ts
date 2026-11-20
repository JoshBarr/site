import { describe, expect, it } from "vitest";
import { createRoadChunks } from "../../src/components/scene/traffic/geometry";
import { Roads } from "../../src/components/scene/traffic/roads";
import { TileIndex } from "../../src/components/scene/terrain/manifest";
import { verticalScale } from "../../src/components/scene/terrain/Terrain";

const ORIGIN: [number, number] = [1740000, 5430000];

const index = new TileIndex({
  crs: "EPSG:2193",
  origin: ORIGIN,
  rootSize: 1,
  tileCells: 1,
  apron: 0,
  encoding: { offset: 0, scale: 1 },
  levels: [{ level: 0, resolution: 1, range: [0, 1, 0, 1], tiles: [] }],
});

/** The ground the road's on, and its deck over the yards, m. */
const GROUND = 2;
const DECK = 15;

/** Points 8 m apart; the deck from BRIDGE[0] to BRIDGE[1], lifted from LIFTED[0]. */
const STEP = 8;
const COUNT = 60;
const BRIDGE = [20, 40];
const LIFTED = [18, 42];

/**
 * A motorway carriageway running east, three lanes: on the ground, up onto
 * a viaduct and down again. With `ground`, as build_decks.py leaves it: the
 * deck at the lidar's height, and the bare earth under it and its
 * approaches noted. Without, as build_roads.mjs does: the bridge straight
 * from end to end.
 */
function motorway(ground: boolean) {
  const points: number[] = [];

  for (let i = 0; i < COUNT; i++) {
    const lifted = ground && i > LIFTED[0] && i < LIFTED[1];

    points.push(ORIGIN[0] + 100 + i * STEP, ORIGIN[1], lifted ? DECK : GROUND);
  }

  return new Roads(
    {
      flags: { tunnel: 1, bridge: 2, twoWay: 4 },
      junction: { joins: 1, leaves: 2 },
      links: [],
      legs: [],
      carriageways: {
        EAST: {
          road: "SH1",
          points,
          spans: [
            [0, 3, 3, 0, 100],
            [BRIDGE[0], 3, 3, 2, 100],
            [BRIDGE[1], 3, 3, 0, 100],
          ],
          junctions: [],
          links: [],
          legs: [],
          ...(ground && {
            ground: [
              [
                LIFTED[0],
                ...Array.from(
                  { length: LIFTED[1] - LIFTED[0] + 1 },
                  () => GROUND
                ),
              ],
            ],
          }),
        },
      },
    },
    index
  );
}

/** Every chunk's geometry of one kind, as [x, y, z] vertices. */
function vertices(roads: Roads, kind: "ground" | "decks") {
  const found: [number, number, number][] = [];

  for (const chunk of createRoadChunks(roads)) {
    const position = chunk.build()[kind]?.getAttribute("position");

    for (let k = 0; k < (position?.count ?? 0); k++) {
      found.push([position!.getX(k), position!.getY(k), position!.getZ(k)]);
    }
  }

  return found;
}

describe("a highway's bridge deck", () => {
  it("is as far above the ground as the lidar found it", () => {
    const [road] = motorway(true).carriageways;
    const scale = verticalScale.value;

    expect(road.clear[0]).toBe(0);
    expect(road.clear[LIFTED[0]]).toBeCloseTo(0);
    expect(road.clear[30]).toBeCloseTo((DECK - GROUND) * scale);
    expect(road.clear[COUNT - 1]).toBe(0);
  });

  it("is drawn apart from the road on the ground, approaches and all", () => {
    const roads = motorway(true);
    const [road] = roads.carriageways;

    const along = (kind: "ground" | "decks") =>
      vertices(roads, kind).map(([x]) => x);

    // Lifted before the map's bridge starts, the road's a structure there
    // too: the bare earth dips at an abutment and the road doesn't.
    expect(Math.min(...along("decks"))).toBeCloseTo(road.x[LIFTED[0]], 3);
    expect(Math.max(...along("decks"))).toBeCloseTo(road.x[LIFTED[1]], 3);
    expect(Math.max(...along("ground"))).toBeCloseTo(road.x[COUNT - 1], 3);

    for (const x of along("ground")) {
      expect(x <= road.x[LIFTED[0]] || x >= road.x[LIFTED[1]]).toBe(true);
    }
  });

  it("stands on piers sunk into the ground, with none at its abutments", () => {
    const roads = motorway(true);
    const [road] = roads.carriageways;
    const ground = GROUND * verticalScale.value;
    const sunk = vertices(roads, "decks").filter(([, y]) => y < ground - 1);

    expect(sunk.length).toBeGreaterThan(0);

    // Piers are under the lanes, not out at the deck's edges.
    const piers = sunk.filter(([, , z]) => Math.abs(z - road.z[0]) < 4);

    expect(new Set(piers.map(([x]) => Math.round(x))).size).toBeGreaterThan(4);

    for (const [x] of piers) {
      expect(x).toBeGreaterThan(road.x[LIFTED[0] + 1]);
      expect(x).toBeLessThan(road.x[LIFTED[1] - 1]);
    }
  });

  it("is still a deck where the lidar didn't place it, without piers", () => {
    const roads = motorway(false);
    const [road] = roads.carriageways;
    const decks = vertices(roads, "decks");

    expect(Math.min(...decks.map(([x]) => x))).toBeCloseTo(
      road.x[BRIDGE[0]],
      3
    );
    expect(Math.max(...decks.map(([x]) => x))).toBeCloseTo(
      road.x[BRIDGE[1]],
      3
    );

    // Nothing reaches further down than the deck's own depth.
    expect(Math.min(...decks.map(([, y]) => y))).toBeGreaterThan(road.y[0] - 3);
  });

  it("leaves a road with no bridges no decks at all", () => {
    const points: number[] = [];

    for (let i = 0; i < 20; i++)
      points.push(ORIGIN[0] + i * STEP, ORIGIN[1], 0);

    const roads = new Roads(
      {
        flags: { tunnel: 1, bridge: 2, twoWay: 4 },
        junction: { joins: 1, leaves: 2 },
        links: [],
        legs: [],
        carriageways: {
          EAST: {
            road: "SH1",
            points,
            spans: [[0, 3, 3, 0, 100]],
            junctions: [],
            links: [],
            legs: [],
          },
        },
      },
      index
    );

    for (const chunk of createRoadChunks(roads)) {
      const { ground, decks } = chunk.build();

      expect(ground).not.toBeNull();
      expect(decks).toBeNull();
    }
  });
});
