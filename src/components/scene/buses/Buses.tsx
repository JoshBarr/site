import { RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from "three/webgpu";
import { attribute, select, uniform, vec3 } from "three/tsl";
import { TileIndex } from "../terrain/manifest";
import type { HeightQuery } from "../terrain/Terrain";
import { castsNearShadow } from "../landmarks/nearShadow";
import { BODY, createCarGeometry, ROOF, WINDOWS } from "../trains/geometry";
import { distanceAt, pointAt } from "../trains/run";
import { createRunLights, createRunTrails } from "../trains/Trains";
import {
  Candidate,
  followed,
  publish,
  subject,
  useFollowCandidates,
} from "../follow/store";
import { BusRoutes, loadBusRoutes } from "./routes";
import { follow, Run } from "./run";
import { useBuses } from "./useBuses";

const MAX_BUSES = 640;

/**
 * Buses are drawn this far behind live, ms, so there's nearly always a fix
 * ahead of them to run to: like the trains, they report about every 30
 * seconds, and the fix takes a while to reach the page.
 */
const DELAY = 45_000;

/**
 * Seconds over which a bus that's fallen behind (it waited at its last fix
 * for the next) makes the time up, at up to three times the pace.
 */
const CATCH_UP = 10;

/**
 * A single-decker, near enough: Metlink runs double-deckers on some routes
 * too, but doesn't say which bus is which.
 */
const BUS = { length: 12.5, width: 2.5, height: 3.2 };
const BUS_TINT = new Color(0xc4c4c4);

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
  const mesh = new InstancedMesh(createCarGeometry(), material, MAX_BUSES);
  // Instances move every frame; their bounds would always be stale.
  mesh.frustumCulled = false;
  mesh.count = 0;
  castsNearShadow(mesh);

  return { mesh, windowsLit };
}

const matrix = new Matrix4();
const rotation = new Quaternion();
const scale = new Vector3(BUS.width, BUS.height, BUS.length);
const front = new Vector3();
const back = new Vector3();
const centre = new Vector3();
const along = new Vector3();
const FORWARD = new Vector3(0, 0, 1);

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
  const epoch = useMemo(() => Date.now(), []);
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
  const playheads = useRef(new Map<string, number>());

  const runs = useMemo(
    () =>
      buses
        .slice(0, MAX_BUSES)
        .map((bus) => follow(bus, routes, index, epoch, heightAt.current))
        .filter((run): run is Run => run !== null),
    [buses, routes, index, epoch, heightAt]
  );

  useFollowCandidates(
    "bus",
    useMemo(
      () =>
        runs.map(({ bus, fixes }): Candidate => ({
          id: bus.id,
          label: `Route ${routes.nameOf(bus.route)}`,
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
  }, [runs, trails]);

  useEffect(() => {
    fleet.windowsLit.value = lights;
  }, [fleet, lights]);

  useEffect(
    () => () => {
      fleet.mesh.geometry.dispose();
      fleet.mesh.material.dispose();
      fleet.mesh.dispose();
      trails.lines.geometry.dispose();
      trails.material.dispose();
      sprites.sprite.material.dispose();
    },
    [fleet, trails, sprites]
  );

  useFrame((_, delta) => {
    const target = (Date.now() - DELAY - epoch) / 1000;
    const { light, tint } = sprites;
    let lit = 0;

    const show = (at: Vector3, tone: Color, intensity: number) => {
      if (lit >= MAX_LIGHTS) return;
      light.setXYZW(lit, at.x, at.y + LIGHT_HEIGHT, at.z, intensity);
      tint.setXYZ(lit, tone.r, tone.g, tone.b);
      lit++;
    };

    let count = 0;
    const watched = followed("bus");
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
          1 + Math.min(Math.max((target - playhead) / CATCH_UP, 0), 2);

        playhead = Math.min(playhead + delta * rate, target, latest);
      }

      playheads.current.set(bus.id, playhead);
      trails.playheads.array[i] = playhead;

      // The fix is taken as the middle of the bus.
      const middle = distanceAt(run, playhead);
      pointAt(run, middle + BUS.length / 2, front);
      pointAt(run, middle - BUS.length / 2, back);
      centre.addVectors(front, back).multiplyScalar(0.5);
      centre.y += RIDE;
      along.subVectors(front, back);

      if (along.lengthSq() > 1e-6) {
        rotation.setFromUnitVectors(FORWARD, along.normalize());
      } else {
        rotation.identity();
      }

      fleet.mesh.setMatrixAt(count++, matrix.compose(centre, rotation, scale));

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

    fleet.mesh.count = count;
    fleet.mesh.instanceMatrix.needsUpdate = true;
    sprites.sprite.count = lit;
    sprites.sprite.visible = lit > 0;
    light.needsUpdate = tint.needsUpdate = true;
  });

  return (
    <>
      <primitive object={fleet.mesh} name="buses" />
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
