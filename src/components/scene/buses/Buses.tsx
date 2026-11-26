import { RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from "three/webgpu";
import {
  attribute,
  instancedBufferAttribute,
  select,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { TileIndex } from "../terrain/manifest";
import type { HeightQuery } from "../terrain/Terrain";
import { castsNearShadow } from "../landmarks/nearShadow";
import { BODY, createCarGeometry, ROOF, WINDOWS } from "../trains/geometry";
import { distanceAt, orient, pointAt } from "../trains/run";
import { createRunLights, createRunTrails } from "../trains/Trains";
import {
  Candidate,
  followed,
  publish,
  subject,
  useFollowCandidates,
  useFollowSpots,
} from "../follow/store";
import { createModelMaterial, isNear, NearModels } from "../models/lod";
import { highways } from "../traffic/shared";
import { createLampMap, lampLight } from "../traffic/signs/matrix";
import { seenUnderground } from "../tunnels/reveal";
import type { RoadUser } from "../traffic/sim";
import { createBusGeometry } from "./model";
import { BusRoutes, loadBusRoutes } from "./routes";
import { easedDistance } from "./ease";
import { follow, keepToKerb, Run } from "./run";
import { BAND_WIDE, BusSigns, SIGN_ROWS } from "./sign";
import { createSpacing } from "./spacing";
import { useBuses } from "./useBuses";
import { sceneNow, useSeek } from "../clock";
import { switchedOff } from "../stats";

const MAX_BUSES = 640;

/**
 * Buses are drawn this far behind live, ms, so there's nearly always a fix
 * ahead of them to run to. They report every 5 seconds, but the poller
 * asks every 20, and with /api/buses's cache and the page's own polls a
 * bus's newest fix is up to ~55 s old when it arrives (measured
 * 2026-11-20; at 45 s, buses stood waiting 10 to 20 s at a time).
 */
const DELAY = 60_000;

/**
 * Seconds behind at which a bus that's waited at its last fix for the next
 * is making the time up at its fastest, FASTER than the usual pace; closer
 * than that, it eases back to it.
 */
const CATCH_UP = 10;

/** How much faster a bus making time up goes: more reads as racing. */
const FASTER = 0.5;

/**
 * A single-decker, near enough: Metlink runs double-deckers on some routes
 * too, but doesn't say which bus is which.
 */
const BUS = { length: 12.5, width: 2.5, height: 3.2, tint: 0xc4c4c4 };
const BUS_TINT = new Color(BUS.tint);

/** Drawn in detail at once, at most. */
const MAX_DETAILED = 48;

/**
 * Different signs kept lit at once: more than are ever drawn, so there's
 * always one out of sight to give up for a new one.
 */
const SIGNS = 64;

/** Kept between a bus and the one ahead of it in its lane, m. */
const GAP = 2;

/**
 * A bus held back behind another lets go at this pace, m/s, once the one
 * ahead moves on; it's never held back further than `MAX_HOLD`, m.
 */
const LET_GO = 3;
const MAX_HOLD = 3 * (BUS.length + GAP);

/** Off the road, m: the DEM's a little rough under it. */
const RIDE = 0.1;

/** Green, against the scene's greys: it's data, like the others. */
const TRAIL_COLOR = new Color(0.45, 1, 0.55);
const TRAIL_OPACITY = 0.35;

/** Pixels. */
const TRAIL_WIDTH = 2;
const MAX_TRAIL_SEGMENTS = 65536;

/** Above the road, m: inside the bus, so it comes out behind it. */
const TRAIL_HEIGHT = 1.6;

/**
 * Behind a bus its trail fades out by age, s: whole at the bus, gone this
 * far back.
 */
const TAIL_FADE = 2 * 60;

/** Further than this along its route in its trail, m, a bus is moving. */
const MOVING = 100;

/** Head and tail lights. */
const MAX_LIGHTS = MAX_BUSES * 2;

/** Above the road, m. */
const LIGHT_HEIGHT = 0.8;
const HEAD = new Color(1, 0.95, 0.85);
const TAIL = new Color(1, 0.07, 0.03);

/** Window glow at night. */
const LIT_WINDOWS = new Color(1, 0.88, 0.7);

function createBuses() {
  const windowsLit = uniform(0);
  const part = attribute<"float">("part", "float");

  const isPart = (p: number) =>
    part.greaterThan(p - 0.5).and(part.lessThan(p + 0.5));

  const material = new MeshStandardNodeMaterial({ roughness: 0.55 });
  material.colorNode = select(
    isPart(BODY),
    vec3(BUS_TINT.r, BUS_TINT.g, BUS_TINT.b),
    select(
      isPart(WINDOWS),
      vec3(0.12),
      select(isPart(ROOF), vec3(0.5), vec3(0.09))
    )
  );
  material.emissiveNode = select(
    isPart(WINDOWS),
    vec3(LIT_WINDOWS.r, LIT_WINDOWS.g, LIT_WINDOWS.b).mul(windowsLit.mul(0.7)),
    vec3(0)
  );

  const mesh = seenUnderground(
    new InstancedMesh(createCarGeometry(), material, MAX_BUSES)
  );

  // Instances move every frame; their bounds would always be stale.
  mesh.frustumCulled = false;
  mesh.count = 0;
  castsNearShadow(mesh);
  const near = createModelMaterial({ roughness: 0.55 });

  // The detailed buses' signs: lamps, lit day and night, each bus's own
  // band of the map.
  const signs = new BusSigns(SIGNS);
  const lampMap = createLampMap(signs.lamps, BAND_WIDE);
  const bands = new InstancedBufferAttribute(new Float32Array(MAX_DETAILED), 1);
  const lamp = attribute<"vec3">("lamp", "vec3");

  const band = instancedBufferAttribute<"float">(bands, "float")
    .add(0.5)
    .floor();

  near.material.emissiveNode = attribute<"vec3">("glow", "vec3")
    .mul(near.lit)
    .add(
      select(
        lamp.z.greaterThan(0.5),
        lampLight(lampMap, lamp.xy.add(vec2(0, band.mul(SIGN_ROWS))), near.lit),
        vec3(0)
      )
    );

  const detailed = new NearModels(
    createBusGeometry(BUS),
    near.material,
    MAX_DETAILED
  );

  seenUnderground(detailed.mesh);

  return {
    mesh,
    windowsLit,
    detailed,
    detailedMaterial: near.material,
    detailedLit: near.lit,
    signs,
    lampMap,
    bands,
  };
}

const matrix = new Matrix4();
const rotation = new Quaternion();
const scale = new Vector3(BUS.width, BUS.height, BUS.length);
const ONE = new Vector3(1, 1, 1);
const front = new Vector3();
const back = new Vector3();
const centre = new Vector3();
const along = new Vector3();

const user: RoadUser = {
  id: "",
  x: 0,
  y: 0,
  z: 0,
  dx: 0,
  dz: 0,
  length: BUS.length,
  width: BUS.width,
  speed: 0,
  held: 0,
};

/**
 * How far along its run a bus is at `time`: eased through its fixes, or
 * under `?off=busease` straight between them.
 */
const distanceOf = (run: Run, time: number) =>
  run.slopes
    ? easedDistance(run.fixes, run.slopes, time)
    : distanceAt(run, time);

/** Puts the bus `run` drives with its middle at `middle` along it. */
function place(run: Run, middle: number) {
  pointAt(run, middle + BUS.length / 2, front);
  pointAt(run, middle - BUS.length / 2, back);
  centre.addVectors(front, back).multiplyScalar(0.5);
  centre.y += RIDE;
  along.subVectors(front, back);
}

/**
 * Metlink's buses at their live positions, run along their routes from fix
 * to fix a little behind live, with trails behind them.
 */
function Fleet({
  index,
  routes,
  heightAt,
  lights,
}: {
  index: TileIndex;
  routes: BusRoutes;
  heightAt: RefObject<HeightQuery | null>;
  lights: number;
}) {
  const buses = useBuses();
  const { epoch } = useSeek();
  const fleet = useMemo(createBuses, []);

  const trails = useMemo(
    () =>
      createRunTrails({
        runs: MAX_BUSES,
        segments: MAX_TRAIL_SEGMENTS,
        color: TRAIL_COLOR,
        opacity: TRAIL_OPACITY,
        width: TRAIL_WIDTH,
        fade: TAIL_FADE,
      }),
    []
  );

  const sprites = useMemo(() => createRunLights(MAX_LIGHTS), []);
  const spots = useFollowSpots("bus");
  const playheads = useRef(new Map<string, number>());
  const holds = useRef(new Map<string, number>());
  const spacing = useMemo(() => createSpacing(MAX_BUSES), []);
  const middles = useMemo(() => new Float32Array(MAX_BUSES), []);
  /** How fast each bus's run takes it now, m/s. */
  const speeds = useMemo(() => new Float32Array(MAX_BUSES), []);
  const eased = useMemo(() => !switchedOff("busease"), []);

  const runs = useMemo(
    () =>
      buses
        .slice(0, MAX_BUSES)
        .map((bus) => {
          const run = follow(
            bus,
            routes,
            index,
            epoch,
            heightAt.current,
            eased
          );

          const roads = highways.traffic?.roads;

          // In traffic, over in the kerb lane.
          return run && roads ? keepToKerb(run, roads) : run;
        })
        .filter((run): run is Run => run !== null),
    [buses, routes, index, epoch, heightAt, eased]
  );

  useFollowCandidates(
    "bus",
    useMemo(
      () =>
        runs.map(({ bus, fixes }): Candidate => ({
          id: bus.id,
          label: `Route ${routes.nameOf(bus.route)}`,
          // Telling apart those on the same route.
          detail: `#${bus.id}`,
          moving: fixes[fixes.length - 1].s - fixes[0].s > MOVING,
        })),
      [runs, routes]
    )
  );

  useEffect(() => {
    const positions = trails.segments.array;
    const stamps = trails.times.array;
    const owners = trails.owner.array;
    let n = 0;
    runs.forEach(({ points, arrived, left }, bus) => {
      for (let i = 0; i < points.length - 1 && n < MAX_TRAIL_SEGMENTS; i++) {
        const [ax, ay, az] = points[i];
        const [bx, by, bz] = points[i + 1];

        if (Number.isNaN(left[i]) || Number.isNaN(arrived[i + 1])) continue;

        if (ax === bx && az === bz) continue;
        positions.set(
          [ax, ay + TRAIL_HEIGHT, az, bx, by + TRAIL_HEIGHT, bz],
          n * 6
        );
        stamps.set([left[i], arrived[i + 1]], n * 2);
        owners[n] = bus;
        n++;
      }
    });
    trails.segments.needsUpdate = trails.times.needsUpdate = true;
    trails.owner.needsUpdate = true;
    trails.lines.geometry.instanceCount = n;

    const present = new Set(runs.map(({ bus }) => bus.id));

    for (const id of playheads.current.keys()) {
      if (!present.has(id)) playheads.current.delete(id);
    }

    for (const id of holds.current.keys()) {
      if (!present.has(id)) holds.current.delete(id);
    }
  }, [runs, trails]);

  useEffect(() => {
    fleet.windowsLit.value = fleet.detailedLit.value = lights;
  }, [fleet, lights]);

  useEffect(
    () => () => {
      fleet.mesh.geometry.dispose();
      fleet.mesh.material.dispose();
      fleet.mesh.dispose();
      fleet.detailedMaterial.dispose();
      fleet.detailed.dispose();
      fleet.lampMap.dispose();
      trails.lines.geometry.dispose();
      trails.material.dispose();
      sprites.sprite.material.dispose();
    },
    [fleet, trails, sprites]
  );

  useFrame(({ camera }, delta) => {
    const target = (sceneNow() - DELAY - epoch) / 1000;
    const { light, tint } = sprites;
    let lit = 0;

    const show = (at: Vector3, tone: Color, intensity: number) => {
      if (lit >= MAX_LIGHTS) return;
      light.setXYZW(lit, at.x, at.y + LIGHT_HEIGHT, at.z, intensity);
      tint.setXYZ(lit, tone.r, tone.g, tone.b);
      lit++;
    };

    // Where each bus would be, less how far it's held back behind the one
    // ahead of it.
    runs.forEach((run, i) => {
      const { bus, fixes } = run;
      const latest = fixes[fixes.length - 1].time;
      // Run on toward now less DELAY; wait at the last fix for the next,
      // then make the time up.
      let playhead = playheads.current.get(bus.id);

      if (playhead === undefined) {
        playhead = Math.min(target, latest);
      } else {
        const rate =
          1 + Math.min(Math.max((target - playhead) / CATCH_UP, 0), 1) * FASTER;

        playhead = Math.min(playhead + delta * rate, target, latest);
      }

      playheads.current.set(bus.id, playhead);
      trails.playheads.array[i] = playhead;

      const hold = Math.max(
        (holds.current.get(bus.id) ?? 0) - LET_GO * delta,
        0
      );

      holds.current.set(bus.id, hold);
      // The fix is taken as the middle of the bus.
      const at = distanceOf(run, playhead);
      middles[i] = at - hold;
      speeds[i] = distanceOf(run, playhead + 1) - at;
      place(run, middles[i]);
      const level = Math.hypot(along.x, along.z) || 1;
      spacing.x[i] = centre.x;
      spacing.z[i] = centre.z;
      spacing.dx[i] = along.x / level;
      spacing.dz[i] = along.z / level;
    });

    // Then any bus in the back of another is held back behind it.
    const push = spacing.resolve(runs.length, BUS.length, GAP);

    let count = 0;
    const watched = followed("bus");
    fleet.detailed.begin();
    fleet.signs.begin();
    spots.begin();
    runs.forEach((run, i) => {
      const { bus } = run;
      const hold = holds.current.get(bus.id) ?? 0;
      let more = Math.max(Math.min(push[i], MAX_HOLD - hold), 0);
      place(run, middles[i] - more);
      const traffic = highways.traffic;

      // On a highway, it's in traffic: held back behind the car ahead (and
      // cars make way for it).
      if (traffic && along.lengthSq() > 1e-6) {
        const level = Math.hypot(along.x, along.z) || 1;
        user.id = bus.id;
        user.x = centre.x;
        user.y = centre.y - RIDE;
        user.z = centre.z;
        user.dx = along.x / level;
        user.dz = along.z / level;
        user.speed = speeds[i];
        user.held = hold + more;
        const wait = Math.min(traffic.share(user, GAP), MAX_HOLD - hold - more);

        if (wait > 0) {
          more += wait;
          place(run, middles[i] - more);
        }
      }

      if (more > 0) holds.current.set(bus.id, hold + more);
      orient(along, rotation);
      spots.add(bus.id, centre.x, centre.y, centre.z, BUS.length);

      const detailed =
        isNear(BUS.length, camera.position.distanceTo(centre)) &&
        fleet.detailed.add(matrix.compose(centre, rotation, ONE));

      if (!detailed) {
        fleet.mesh.setMatrixAt(
          count++,
          matrix.compose(centre, rotation, scale)
        );
      } else {
        // Its signs: its route's number, and where it's going.
        const slot = fleet.detailed.size - 1;

        const band = fleet.signs.bandFor(
          routes.nameOf(bus.route),
          run.destination
        );

        if (fleet.bands.array[slot] !== band) {
          fleet.bands.array[slot] = band;
          fleet.bands.needsUpdate = true;
        }
      }

      if (bus.id === watched) {
        publish({
          x: centre.x,
          y: centre.y,
          z: centre.z,
          heading:
            along.lengthSq() > 1e-6
              ? Math.atan2(along.x, -along.z)
              : subject.heading,
          length: BUS.length,
        });
      }

      if (lights > run.switchOn) {
        show(front, HEAD, 1);
        show(back, TAIL, 0.8);
      }
    });

    fleet.detailed.end();

    if (fleet.signs.changed) {
      fleet.signs.changed = false;
      fleet.lampMap.needsUpdate = true;
    }

    fleet.mesh.count = count;
    fleet.mesh.instanceMatrix.needsUpdate = true;
    sprites.sprite.count = lit;
    sprites.sprite.visible = lit > 0;
    light.needsUpdate = tint.needsUpdate = true;
  });

  return (
    <>
      <primitive object={fleet.mesh} name="buses" />
      <primitive object={fleet.detailed.mesh} name="detailed buses" />
      <primitive object={trails.lines} name="bus trails" />
      <primitive object={sprites.sprite} name="bus lights" />
    </>
  );
}

/**
 * Metlink's buses, running live along their routes wherever they are on
 * the map, with green trails. A bus off every way its route goes (on a
 * detour, say) runs straight between its fixes on the ground `heightAt`
 * finds. `lights` (0..1), how far through lighting-up, lights them for
 * night.
 */
export function Buses({
  index,
  heightAt,
  lights = 0,
}: {
  index: TileIndex;
  heightAt: RefObject<HeightQuery | null>;
  lights?: number;
}) {
  const [routes, setRoutes] = useState<BusRoutes | null>(null);

  useEffect(() => {
    loadBusRoutes(index).then(setRoutes, (e) => console.error(e));
  }, [index]);

  if (!routes) return null;

  return (
    <Fleet index={index} routes={routes} heightAt={heightAt} lights={lights} />
  );
}
