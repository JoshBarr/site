import { GreaterDepth, Mesh, Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { verticalScale } from "../../src/components/scene/terrain/Terrain";
import {
  type NetworkFile,
  RailNetwork,
} from "../../src/components/scene/trains/network";
import {
  railBores,
  roadBores,
  underground,
} from "../../src/components/scene/tunnels/bores";
import {
  createLinings,
  createPortals,
  LAMP,
  ROAD,
} from "../../src/components/scene/tunnels/geometry";
import {
  createCutaway,
  cutRadius,
  seenUnderground,
  seeThrough,
} from "../../src/components/scene/tunnels/reveal";
import { originIndex } from "../fixtures/terrain";

// The tunnels as bores, their linings and portals, and the ground cut away
// round what's followed through one. Here, the railway: a double track
// running 1 km north from the origin (the down line, and the up line 4 m
// east of it) through a tunnel from 300 m to 700 m; a single line 500 m
// east through a tunnel mapped in two pieces; an underpass 9 m long; and a
// tunnel that runs off the map. World x is east and z south.

const TUNNEL = 1;

/** Nodes along `e`, every `step` m north from 0: `count` of them. */
const line = (e: number, count: number, step = 100) =>
  Array.from({ length: count }, (_, k) => [e, k * step, 0]).flat();

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, k) => from + k);

const file: NetworkFile = {
  flags: { tunnel: TUNNEL, bridge: 2, model: 4 },
  nodes: [
    // Down: 0–10. Up: 11–21.
    ...line(0, 11),
    ...line(4, 11),
    // The single line: 22–26.
    ...line(500, 5),
    // The underpass: 27–30, 9 m apart.
    ...line(800, 4, 9),
    // Off the map: 31–33.
    ...line(900, 3),
  ],
  ways: [
    [0, ...range(0, 4)],
    [TUNNEL, ...range(3, 5)],
    [0, ...range(7, 4)],
    [0, ...range(11, 4)],
    [TUNNEL, ...range(14, 5)],
    [0, ...range(18, 4)],
    [0, 22, 23],
    [TUNNEL, 23, 24],
    [TUNNEL, 24, 25],
    [0, 25, 26],
    [0, 27, 28],
    [TUNNEL, 28, 29],
    [0, 29, 30],
    [0, 31, 32],
    [TUNNEL, 32, 33],
  ],
  platforms: [],
};

const index = originIndex();
const bores = railBores(new RailNetwork(file, index));
const [down, up, single, edge] = bores;

/** A road tunnel 100 m long, climbing 2 m northward. */
const [road] = roadBores(
  {
    tunnels: [
      {
        name: "Test Tunnel",
        lanes: 2,
        lane: 3.2,
        width: 7.2,
        height: 5,
        top: 0.25,
        points: [2000, 0, 10, 2000, 50, 11, 2000, 100, 12],
      },
    ],
  },
  index
);

/** A geometry's vertices that are `part`, as [x, y, z] and their normals. */
function partsOf(geometry: Mesh["geometry"], part: number) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const parts = geometry.getAttribute("part");
  const found: { at: Vector3; facing: Vector3 }[] = [];

  for (let i = 0; i < position.count; i++) {
    if (parts.getX(i) !== part) continue;
    found.push({
      at: new Vector3().fromBufferAttribute(position, i),
      facing: new Vector3().fromBufferAttribute(normal, i),
    });
  }

  return found;
}

describe("the railway's bores", () => {
  it("is one for each track through each tunnel the ground covers", () => {
    // Not the underpass: 9 m isn't under a hill.
    expect(bores).toHaveLength(4);
    expect(bores.every(({ kind }) => kind === "rail")).toBe(true);
    expect(down.points).toHaveLength(5);
    expect(down.along).toEqual([0, 100, 200, 300, 400]);
  });

  it("joins a tunnel mapped in pieces", () => {
    expect(single.points.map(([, , z]) => z)).toEqual([-100, -200, -300]);
  });

  it("opens two tracks through one tunnel to each other, half way each", () => {
    // Running north, the up line's to the right of the down.
    expect(down.openRight.every(Boolean)).toBe(true);
    expect(down.openLeft.some(Boolean)).toBe(false);
    expect(down.right).toEqual([2, 2, 2, 2, 2]);
    expect(down.left).toEqual([2.5, 2.5, 2.5, 2.5, 2.5]);

    expect(up.openLeft.every(Boolean)).toBe(true);
    expect(up.openRight.some(Boolean)).toBe(false);
    expect(up.left).toEqual([2, 2, 2, 2, 2]);

    // On its own, a wall each side.
    expect(single.openLeft.some(Boolean)).toBe(false);
    expect(single.openRight.some(Boolean)).toBe(false);
  });

  it("has a portal where the track comes out, not where it leaves the map", () => {
    expect(down.portals).toEqual([true, true]);
    expect(single.portals).toEqual([true, true]);
    expect(edge.portals).toEqual([true, false]);
  });
});

describe("the roads' bores", () => {
  it("is one for both ways, its floor at the road's surface", () => {
    const scale = verticalScale.value;

    expect(road.kind).toBe("road");
    expect(road.points[0][0]).toBe(2000);
    expect(road.points[0][1]).toBeCloseTo(10 * scale + 0.25, 4);
    expect(road.points[2][1]).toBeCloseTo(12 * scale + 0.25, 4);
    expect(road.points[2][2]).toBe(-100);
    expect(road.left).toEqual([3.6, 3.6, 3.6]);
    expect(road.right).toEqual([3.6, 3.6, 3.6]);
    expect(road.portals).toEqual([true, true]);
    expect(road.lanes).toBe(2);
  });

  it("leaves a single lane unmarked", () => {
    const [lane] = roadBores(
      {
        tunnels: [
          {
            name: "Bus Tunnel",
            lanes: 1,
            lane: 3.2,
            width: 7.2,
            height: 5,
            top: 0,
            points: [0, 0, 0, 0, 100, 0],
          },
        ],
      },
      index
    );

    expect(lane.lanes).toBe(0);
  });
});

describe("what's underground", () => {
  it("is nothing till bores are listed, and nothing after", () => {
    expect(underground.inside(0, 0, -500)).toBe(0);
    const remove = underground.add(bores);

    expect(underground.inside(0, 0, -500)).toBeGreaterThan(0);
    remove();
    expect(underground.inside(0, 0, -500)).toBe(0);
  });

  it("is how far in from the nearer portal", () => {
    const remove = underground.add(bores);

    expect(underground.inside(0, 0, -500)).toBeCloseTo(200, 6);
    expect(underground.inside(0, 0, -310)).toBeCloseTo(10, 6);
    expect(underground.inside(0, 0, -690)).toBeCloseTo(10, 6);
    // The other track, in its own bore.
    expect(underground.inside(4, 0, -400)).toBeCloseTo(100, 6);
    // Out in the open, either end.
    expect(underground.inside(0, 0, -250)).toBe(0);
    expect(underground.inside(0, 0, -750)).toBe(0);
    // One that runs off the map has only the one way out.
    expect(underground.inside(900, 0, -150)).toBeCloseTo(50, 6);
    remove();
  });

  it("isn't beside a tunnel, or on the hill over it", () => {
    const remove = underground.add(bores);

    // Past the down line's wall, 2.5 m off: unless there's slack.
    expect(underground.inside(-3, 0, -500)).toBe(0);
    expect(underground.inside(-3, 0, -500, 1)).toBeCloseTo(200, 6);
    // On the street over it.
    expect(underground.inside(0, 20, -500)).toBe(0);
    remove();
  });
});

describe("the portals", () => {
  const chunks = createPortals(bores);

  it("stand at each end that has one, a dark mouth in each", () => {
    // All within one square of the map.
    expect(chunks).toHaveLength(1);
    const mark = chunks[0].geometry.getAttribute("mark");
    let mouths = 0;

    for (let i = 0; i < mark.count; i++) mouths += mark.getX(i);

    // Seven ends, eight strips across each arch, two triangles a strip.
    expect(mouths).toBe(7 * 8 * 6);
  });

  it("have a wing only where there's a wall: two tracks share a headwall", () => {
    const { min } = chunks[0].box;

    // The down line's wall is 2.5 m west of it, and its wing 2 m more.
    expect(min.x).toBeCloseTo(-4.5, 6);

    const position = chunks[0].geometry.getAttribute("position");
    let east = -Infinity;

    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);

      if (x < 100) east = Math.max(east, x);
    }

    // And the up line's the same to the east: nothing between them.
    expect(east).toBeCloseTo(8.5, 6);
  });

  it("stand over the crown, on a footing below the floor", () => {
    const { min, max } = chunks[0].box;

    expect(max.y).toBeGreaterThan(down.height);
    expect(min.y).toBeLessThan(0);
  });
});

describe("the linings", () => {
  it("face inward: a floor seen from above, a roof from below", () => {
    const geometry = createLinings([road]);
    const floor = partsOf(geometry, ROAD);

    expect(floor.length).toBe(2 * 6);
    expect(floor.every(({ facing }) => facing.y > 0.99)).toBe(true);

    const lamps = partsOf(geometry, LAMP);

    expect(lamps.length).toBeGreaterThan(0);
    // Hung from the arch, shining down.
    expect(lamps.every(({ facing }) => facing.y < 0)).toBe(true);
    expect(lamps.every(({ at }) => at.y > road.points[0][1] + 3)).toBe(true);
  });

  it("marks a road's lanes across its floor, kerb to kerb", () => {
    const geometry = createLinings([road]);
    const mark = geometry.getAttribute("mark");
    const parts = geometry.getAttribute("part");
    const across: number[] = [];

    for (let i = 0; i < mark.count; i++) {
      if (parts.getX(i) !== ROAD) continue;
      across.push(mark.getX(i));
      expect(mark.getZ(i)).toBe(2);
    }

    // 0.4 m of seal beyond the outer lanes, each 3.2 m.
    expect(Math.min(...across)).toBeCloseTo(-0.125, 6);
    expect(Math.max(...across)).toBeCloseTo(2.125, 6);
  });

  it("keeps shorter tunnels where it's told what's long enough", () => {
    // The underpass, 9 m: as a branch of the cable car's passing loop is.
    const kept = railBores(new RailNetwork(file, index), {
      half: 2,
      height: 4.6,
      shortest: 5,
    });

    expect(kept).toHaveLength(5);
    expect(kept[3].along.at(-1)).toBe(9);
  });

  it("lays track in a rail bore, and hangs lamps only by a wall", () => {
    const geometry = createLinings([down, up]);

    expect(partsOf(geometry, ROAD)).toHaveLength(0);

    const lamps = partsOf(geometry, LAMP);

    expect(lamps.length).toBeGreaterThan(0);
    // None over the middle, between the tracks.
    expect(lamps.every(({ at }) => at.x < 0 || at.x > 4)).toBe(true);
  });
});

describe("the cutaway", () => {
  it("opens round what's followed, and closes up when it's let go", () => {
    const cut = createCutaway();
    const at = new Vector3(10, 5, 20);

    expect(cutRadius.value).toBe(0);
    expect(cut.mesh.scale.x).toBe(0);

    // A four-car train.
    seeThrough(at, 86);
    cut.update(0.1);

    expect(cutRadius.value).toBeGreaterThan(0);
    expect(cutRadius.value).toBeLessThan(65.6);

    cut.update(1);

    // Past both its ends.
    expect(cutRadius.value).toBeCloseTo(86 * 0.6 + 14, 6);
    expect(cut.mesh.scale.x).toBeCloseTo(65.6, 6);
    expect(cut.mesh.position.x).toBe(10);
    expect(cut.mesh.position.z).toBe(20);
    // Its floor's under the tunnel's, its top over the roof.
    expect(cut.mesh.position.y).toBeLessThan(5 - 0.65);
    expect(cut.mesh.position.y + cut.mesh.scale.y).toBeGreaterThan(5 + 6);

    seeThrough(null);
    cut.update(0.1);

    // Closing, where it was.
    expect(cutRadius.value).toBeGreaterThan(0);
    expect(cut.mesh.position.x).toBe(10);

    cut.update(1);

    expect(cutRadius.value).toBe(0);
    expect(cut.mesh.scale.x).toBe(0);
    cut.dispose();
  });

  it("slopes with what's followed up a grade", () => {
    const cut = createCutaway();

    // A cable car heading east, up 1 in 5.
    seeThrough(new Vector3(0, 50, 0), 10.5, 0.2, Math.PI / 2);
    cut.update(1);

    const radius = cut.mesh.scale.x;

    const floor = (x: number, z: number) =>
      new Vector3(x, 0, z).applyMatrix4(cut.mesh.matrix);

    // Up ahead, down behind, level across; its middle where it was.
    expect(floor(0, 0).toArray()).toEqual([0, 50 - 1.6, 0]);
    expect(floor(1, 0).y - floor(-1, 0).y).toBeCloseTo(2 * radius * 0.2, 6);
    expect(floor(1, 0).x).toBeCloseTo(radius, 6);
    expect(floor(0, 1).y).toBeCloseTo(50 - 1.6, 6);

    // Its walls still upright.
    const top = new Vector3(1, 1, 0).applyMatrix4(cut.mesh.matrix);
    expect(top.x).toBeCloseTo(radius, 6);

    seeThrough(null);
    cut.update(1);
    cut.dispose();
  });

  it("is drawn among the solid things, before what's seen through it", () => {
    const cut = createCutaway();
    const { material } = cut.mesh;
    const vehicle = seenUnderground(new Mesh());

    // Not in the transparent pass, which comes after every vehicle.
    expect(material.transparent).toBe(false);
    // Only where something's in front of its far side.
    expect(material.depthFunc).toBe(GreaterDepth);
    expect(material.depthWrite).toBe(true);
    expect(vehicle.renderOrder).toBeGreaterThan(cut.mesh.renderOrder);
    cut.dispose();
  });
});
