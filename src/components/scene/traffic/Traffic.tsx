import { useEffect, useMemo, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Sphere,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
} from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  fract,
  fwidth,
  instancedBufferAttribute,
  max,
  min,
  mix,
  positionGeometry,
  pow,
  round,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  vec3,
} from "three/tsl";
import { TileIndex } from "../terrain/manifest";
import { pixelAngle } from "../landmarks/common";
import { hazeTransmittance } from "../haze";
import { distantDim, lampGlow, rowShare } from "../lamps";
import {
  ASPHALT,
  BODY,
  BOX,
  createCarGeometry,
  createRoadChunks,
  createTruckGeometry,
  GLASS,
  MOUTH,
} from "./geometry";
import { loadRoads, Place, Roads } from "./roads";
import { Traffic as TrafficSim } from "./sim";
import { overrideFromUrl } from "./speeds";
import { useTraffic } from "./useTraffic";

/**
 * Road is drawn this near the camera, m, and dropped once twice as far:
 * beyond, a carriageway's under a couple of pixels.
 */
const ROAD_RANGE = 9000;

/** Vehicles are drawn this near, m. */
const VEHICLE_RANGE = 14000;

/** Vehicles simulated at most, on all the roads: desktop and phones. */
const MAX_VEHICLES = 24000;
const MAX_VEHICLES_MOBILE = 9000;

const ROAD = new Color(0x464646);
const LINES = new Color(0xc8c8c8);
const CONCRETE_TONE = new Color(0x7a7a7a);

/** Lane markings, m: half a line's width, lane width, and the dashes. */
const LINE_HALF = 0.075;
const LANE_M = 3.4;
const DASH = 12;
const DASH_ON = 0.25;

/**
 * Far off, vehicles are drawn at least this many pixels long, up to this
 * many times their size: a stream of specks, not nothing.
 */
const MIN_PIXELS = 2.5;
const MAX_GROW = 6;

/** Head and tail lights: above the road, m; at least a pixel size. */
const LIGHT_HEIGHT = 0.7;
const LIGHT_SIZE = 0.5;
const LIGHT_PIXELS = 6;
const HEAD = new Color(1, 0.92, 0.75);
const TAIL = new Color(1, 0.06, 0.03);
const HEAD_BRIGHTNESS = 3;
const TAIL_BRIGHTNESS = 5;

/**
 * Headlights are dipped, aimed down the road: seen from above the beam,
 * this sine of the view's elevation up, they're down to a share of it.
 */
const BEAM_TOP = [0.05, 0.3];
const ABOVE_BEAM = 0.5;

/**
 * Lights down a lane pile up seen along it, so each gives its share (see
 * rowShare), but never under this: a short run of cars, where shares don't
 * add up to one light's worth, still shows.
 */
const LIGHT_LEAST = 0.125;

/** The road surfaces, each chunk built when the camera first comes near. */
function Surfaces({ roads }: { roads: Roads }) {
  const camera = useThree((state) => state.camera);

  const { group, material, chunks } = useMemo(() => {
    const material = new MeshStandardNodeMaterial({
      roughness: 0.92,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });

    const part = attribute<"float">("part", "float");
    const mark = attribute<"vec4">("mark", "vec4");

    const isPart = (p: number) =>
      part.greaterThan(p - 0.5).and(part.lessThan(p + 0.5));

    // Lines at whole lanes from the kerb: solid at the edges, dashed
    // between lanes and down the middle of a two-way road.
    const across = mark.x;
    const along = mark.y;
    const lanes = mark.z;
    const k = clamp(round(across), 0, lanes);
    const distance = abs(across.sub(k)).mul(LANE_M);
    const blur = fwidth(across).mul(LANE_M).add(1e-4);

    const cover = smoothstep(
      blur.add(LINE_HALF),
      float(LINE_HALF).sub(blur),
      distance
    ).mul(min(float(LINE_HALF * 2).div(blur), 1));

    const dashed = k
      .greaterThan(0.5)
      .and(k.lessThan(lanes.sub(0.5)).or(mark.w.greaterThan(0.5)));

    const dash = mix(
      step(fract(along.div(DASH)), DASH_ON),
      float(DASH_ON),
      clamp(
        fwidth(along)
          .div(DASH * DASH_ON)
          .sub(0.5),
        0,
        1
      )
    );

    const line = cover.mul(select(dashed, dash, float(1)));
    const road = vec3(ROAD.r, ROAD.g, ROAD.b);
    const lines = vec3(LINES.r, LINES.g, LINES.b);
    material.colorNode = select(
      isPart(ASPHALT),
      mix(road, lines, line),
      select(
        isPart(MOUTH),
        vec3(0.004),
        vec3(CONCRETE_TONE.r, CONCRETE_TONE.g, CONCRETE_TONE.b)
      )
    );

    return {
      group: new Group(),
      material,
      chunks: createRoadChunks(roads).map(
        (chunk): typeof chunk & { mesh: Mesh | null } => ({
          ...chunk,
          mesh: null,
        })
      ),
    };
  }, [roads]);

  useEffect(
    () => () => {
      for (const chunk of chunks) chunk.mesh?.geometry.dispose();
      group.clear();
      material.dispose();
    },
    [group, material, chunks]
  );

  useFrame(() => {
    camera.getWorldPosition(eye);
    let next: (typeof chunks)[number] | null = null;
    let nearest = ROAD_RANGE;

    for (const chunk of chunks) {
      const distance = chunk.box.distanceToPoint(eye);

      if (chunk.mesh) {
        chunk.mesh.visible = distance < ROAD_RANGE;

        if (distance > ROAD_RANGE * 2) {
          group.remove(chunk.mesh);
          chunk.mesh.geometry.dispose();
          chunk.mesh = null;
        }
      } else if (distance < nearest) {
        nearest = distance;
        next = chunk;
      }
    }

    if (next) {
      next.mesh = new Mesh(next.build(), material);
      next.mesh.receiveShadow = true;
      group.add(next.mesh);
    }
  });

  return <primitive object={group} name="roads" />;
}

/**
 * One kind of vehicle, drawn from per-vehicle attributes: where it is and
 * which way it faces, its size and paint, and how bright its lights are.
 */
function createFleet(geometry: BufferGeometry, capacity: number) {
  const place = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const shape = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const glow = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);

  for (const a of [place, shape, glow]) a.setUsage(DynamicDrawUsage);

  const at = instancedBufferAttribute<"vec4">(place, "vec4");
  const size = instancedBufferAttribute<"vec4">(shape, "vec4");
  const lit = instancedBufferAttribute<"vec3">(glow, "vec3");
  const centre = at.xyz;
  const heading = at.w;
  const forward = vec3(sin(heading), 0, cos(heading));

  const grow = clamp(
    cameraPosition
      .distance(centre)
      .mul(pixelAngle)
      .mul(MIN_PIXELS)
      .div(max(size.x, 0.1)),
    1,
    MAX_GROW
  );

  const material = new MeshStandardNodeMaterial({
    roughness: 0.4,
    metalness: 0.15,
    flatShading: true,
    side: DoubleSide,
  });

  const local = positionGeometry.mul(vec3(size.y, size.z, size.x)).mul(grow);
  const c = cos(heading);
  const s = sin(heading);
  material.positionNode = vec3(
    local.x.mul(c).add(local.z.mul(s)),
    local.y,
    local.z.mul(c).sub(local.x.mul(s))
  ).add(centre);
  const part = attribute<"float">("part", "float");

  const isPart = (p: number) =>
    part.greaterThan(p - 0.5).and(part.lessThan(p + 0.5));

  const paint = pow(size.w, 2.2);
  material.colorNode = select(
    isPart(BODY),
    vec3(paint),
    select(
      isPart(BOX),
      vec3(min(paint.mul(1.1), 1)),
      select(isPart(GLASS), vec3(0.03), vec3(0.02))
    )
  );
  const mesh = new Mesh(geometry, material);
  mesh.count = 0;
  mesh.frustumCulled = false;

  // Lights, at the front and back: seen from ahead and behind respectively.
  const lights = (
    end: 1 | -1,
    tint: Color,
    brightness: number,
    intensity: typeof lit.x
  ) => {
    const sprite = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    sprite.fog = false;

    const position = centre
      .add(forward.mul(size.x.mul(0.5 * end).mul(grow)))
      .add(vec3(0, float(LIGHT_HEIGHT).mul(grow), 0));

    sprite.positionNode = position;
    const toCamera = cameraPosition.sub(position);
    const distance = toCamera.length();

    const scale = max(
      float(LIGHT_SIZE),
      distance.mul(pixelAngle).mul(LIGHT_PIXELS)
    );

    sprite.scaleNode = scale;
    const facing = dot(forward.mul(end), toCamera.div(distance));

    const share = rowShare({
      toCamera,
      distance,
      row: forward,
      spacing: lit.z,
      size: scale,
      least: LIGHT_LEAST,
    });

    const beam =
      end === 1
        ? mix(
            float(1),
            float(ABOVE_BEAM),
            smoothstep(BEAM_TOP[0], BEAM_TOP[1], toCamera.y.div(distance))
          )
        : float(1);

    sprite.colorNode = vec3(tint.r, tint.g, tint.b)
      .mul(lampGlow(0.4).mul(intensity).mul(share).mul(brightness))
      .mul(smoothstep(-0.6, 0.3, facing).mul(beam).mul(distantDim(distance)))
      .mul(sqrt(hazeTransmittance(cameraPosition, position)));
    const object = new Sprite(sprite);
    object.count = 0;
    object.frustumCulled = false;
    object.renderOrder = 10;

    return object;
  };

  const heads = lights(1, HEAD, HEAD_BRIGHTNESS, lit.x);
  const tails = lights(-1, TAIL, TAIL_BRIGHTNESS, lit.y);

  return { mesh, heads, tails, place, shape, glow, capacity };
}

type Fleet = ReturnType<typeof createFleet>;

const eye = new Vector3();
const front: Place = { x: 0, y: 0, z: 0 };
const back: Place = { x: 0, y: 0, z: 0 };
const frustum = new Frustum();
const viewProjection = new Matrix4();
const sphere = new Sphere();

/** Simulated traffic, at NZTA's speeds, drawn near the camera. */
function Vehicles({
  roads,
  index,
  lights,
  time,
}: {
  roads: Roads;
  index: TileIndex;
  lights: number;
  time: Date;
}) {
  const { speeds, ready } = useTraffic();

  const mobile = useMemo(
    () => window.matchMedia("(pointer: coarse)").matches,
    []
  );

  const limit = mobile ? MAX_VEHICLES_MOBILE : MAX_VEHICLES;

  const traffic = useMemo(
    () => new TrafficSim(roads, index, limit),
    [roads, index, limit]
  );

  const fleets = useMemo(
    () => [
      createFleet(createCarGeometry(), limit),
      createFleet(createTruckGeometry(), Math.ceil(limit * 0.2)),
    ],
    [limit]
  );

  const override = useMemo(overrideFromUrl, []);
  // The time of day, to the quarter hour: how busy it should be.
  const quarter = Math.floor(time.getTime() / (15 * 60_000));

  useEffect(() => {
    if (!ready) return;
    traffic.setConditions(speeds, override, new Date(quarter * 15 * 60_000));
  }, [traffic, speeds, ready, override, quarter]);

  useEffect(
    () => () => {
      for (const fleet of fleets) {
        fleet.mesh.geometry.dispose();
        fleet.mesh.material.dispose();
        fleet.heads.material.dispose();
        fleet.tails.material.dispose();
      }
    },
    [fleets]
  );

  useFrame(({ camera }, delta) => {
    traffic.step(delta);

    camera.getWorldPosition(eye);
    viewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    frustum.setFromProjectionMatrix(viewProjection);
    const range = VEHICLE_RANGE * VEHICLE_RANGE;
    const counts = [0, 0];

    for (const flow of traffic.flows) {
      const { road } = flow;

      for (const car of flow.cars) {
        const lateral = car.lateral + car.slide;
        const hint = road.placeAt(car.s, lateral, front, car.hint);
        road.placeAt(car.s - car.length, lateral, back, hint);
        const x = (front.x + back.x) / 2;
        const y = (front.y + back.y) / 2;
        const z = (front.z + back.z) / 2;
        const dx = x - eye.x;
        const dz = z - eye.z;

        if (dx * dx + dz * dz > range) continue;
        sphere.center.set(x, y, z);
        sphere.radius = car.length * MAX_GROW;

        if (!frustum.intersectsSphere(sphere)) continue;

        const kind = car.truck ? 1 : 0;
        const fleet: Fleet = fleets[kind];
        const n = counts[kind];

        if (n >= fleet.capacity) continue;
        counts[kind]++;
        const p = fleet.place.array;
        p[n * 4] = x;
        p[n * 4 + 1] = y;
        p[n * 4 + 2] = z;
        p[n * 4 + 3] = Math.atan2(front.x - back.x, front.z - back.z);
        const fade = Math.min(Math.max(car.fade, 0), 1);
        const scale = fade * (2 - fade);
        const sh = fleet.shape.array;
        sh[n * 4] = car.length * scale;
        sh[n * 4 + 1] = car.width * scale;
        sh[n * 4 + 2] = car.height * scale;
        sh[n * 4 + 3] = car.tone;
        const on = lights > car.switchOn;
        const g = fleet.glow.array;
        g[n * 3] = on ? scale : 0;
        g[n * 3 + 1] = (on ? 0.45 + car.brake * 0.9 : car.brake * 0.25) * scale;
        g[n * 3 + 2] = car.spacing;
      }
    }

    fleets.forEach((fleet, kind) => {
      const n = counts[kind];
      fleet.mesh.count = n;
      fleet.heads.count = fleet.tails.count = n;
      fleet.heads.visible = fleet.tails.visible = n > 0;

      for (const [attribute, size] of [
        [fleet.place, 4],
        [fleet.shape, 4],
        [fleet.glow, 3],
      ] as const) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, n * size);
        attribute.needsUpdate = true;
      }
    });
  });

  return (
    <>
      {fleets.map((fleet, i) => (
        <group key={i}>
          <primitive object={fleet.mesh} name="cars" />
          <primitive object={fleet.heads} name="headlights" />
          <primitive object={fleet.tails} name="tail lights" />
        </group>
      ))}
    </>
  );
}

/**
 * Traffic on State Highways 1 and 2 through the city and up the coast and
 * the Hutt: the roads themselves, and vehicles simulated to go at the
 * speeds NZTA measures, live, queues and all. `lights` (0..1), how far
 * through lighting-up, puts their lights on for night; `time`, the scene's
 * clock, is how busy the roads should be. `?traffic=jam|free|<km/h>`
 * forces the speeds.
 */
export function Traffic({
  index,
  lights = 0,
  time,
}: {
  index: TileIndex;
  lights?: number;
  time: Date;
}) {
  const [roads, setRoads] = useState<Roads | null>(null);

  useEffect(() => {
    loadRoads(index).then(setRoads, (e) => console.error(e));
  }, [index]);

  if (!roads) return null;

  return (
    <>
      <Surfaces roads={roads} />
      <Vehicles roads={roads} index={index} lights={lights} time={time} />
    </>
  );
}
