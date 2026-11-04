import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  Color,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  Matrix4,
  MeshStandardNodeMaterial,
  NormalBlending,
  Quaternion,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
} from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  exp,
  float,
  instancedBufferAttribute,
  max,
  mix,
  positionGeometry,
  select,
  smoothstep,
  sqrt,
  uniform,
  uv,
  varying,
  vec3,
} from "three/tsl";
import { LineSegments2 } from "three/examples/jsm/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { pixelAngle, random } from "../landmarks/common";
import { hazeTransmittance } from "../haze";
import { TrailMaterial } from "../trailMaterial";
import {
  OceanConditions,
  peakPeriod,
  significantHeight,
} from "../ocean/spectrum";
import {
  createBlockGeometry,
  createHullGeometry,
  createWakeGeometry,
} from "./geometry";
import { TRAIL, TRAIL_GAP, UNDER_WAY } from "../../../lib/vessels";
import { useVessels, Vessel } from "./useVessels";
import { sceneNow, useSeek } from "../clock";
import { useShore } from "./shore";
import { createShipModel, Kind, Lights, Point } from "./models";
import { createModelMaterial, HIDDEN, isNear } from "../models/lod";
import { castsNearShadow } from "../landmarks/nearShadow";
import { seaLevel } from "../environment";
import {
  Candidate,
  followed,
  publish,
  useFollowCandidates,
  useFollowSpots,
} from "../follow/store";

const MAX_VESSELS = 256;

/** Superstructure and deck cargo. */
const MAX_PARTS_PER_VESSEL = 2;

/**
 * Carry on along the last course for at most this long, seconds. The feed
 * relays only a report every few minutes per ship around Wellington.
 */
const MAX_DEAD_RECKONING = 300;

/** Seconds to ease onto a new report rather than jump. */
const SETTLE = 5;

/** Further off than this (m), a new report is a jump, not a correction. */
const SNAP = 1500;

/**
 * Metres between a hull and the shore, past half its beam: fenders, and the
 * shore's own few metres of doubt.
 */
const BERTH_GAP = 2;

/** Wake length per m/s of speed. */
const WAKE_SECONDS = 25;

/** How much of the waves' heave and slope a small boat takes on: slightly. */
const BOB = 0.35;
const G = 9.81;

/** Masthead, sidelights and stern light under way; an anchor light moored. */
const LIGHTS_PER_VESSEL = 4;
const MAX_LIGHTS = MAX_VESSELS * LIGHTS_PER_VESSEL;

/** Smallest light, metres; most are bigger on screen, see MIN_PIXELS. */
const LIGHT_SIZE = 1;

/** Small: a couple of bright pixels at range. */
const LIGHT_PIXELS = 8;

/**
 * A moored boat's all-round light is a dim one, and marinas are full of
 * them: at full strength they piled up into blooms bigger than any house.
 */
const ANCHOR_LIGHT = 0.15;

/** Sidelights show from dead ahead to 22.5° abaft the beam; the stern the rest. */
const SIDELIGHT_ARC = (112.5 * Math.PI) / 180;

/** Arcs blend over this, so a light doesn't pop as the camera crosses. */
const ARC_BLEND = (4 * Math.PI) / 180;

const NAV_RED = new Color(1, 0.07, 0.03);
const NAV_GREEN = new Color(0.1, 1, 0.35);
const NAV_WHITE = new Color(1, 0.95, 0.85);

/** Light blue, against the scene's greys: it's data, not part of the view. */
const TRAIL_COLOR = new Color(0.35, 0.7, 1);

/** As strong as an aircraft's. */
const TRAIL_OPACITY = 0.35;

/** Pixels. */
const TRAIL_WIDTH = 2;
const MAX_TRAIL_SEGMENTS = 4096;

/** Above the sea, metres, clear of its waves. */
const TRAIL_HEIGHT = 1;

/**
 * Behind a ship, its trail is whole for this many seconds, then fades out,
 * the oldest first, until it's gone at TRAIL: like an aircraft's, but slower,
 * as ships are.
 */
const TAIL_HOLD = 2 * 60;
const TAIL_FADE = TRAIL / 1000 - TAIL_HOLD;

/** Time of a trail's end at the ship, seconds: always now. */
const FUTURE = 1e9;

/**
 * Detailed models built in a frame, at most, so a harbour full of boats
 * coming into view isn't built all at once.
 */
const BUILDS_PER_FRAME = 1;

function kindOf(type: number): Kind {
  if (type >= 60 && type < 70) return "passenger";

  if (type >= 70 && type < 80) return "cargo";

  if (type >= 80 && type < 90) return "tanker";

  if (type === 31 || type === 32 || type === 52) return "tug";

  if (type === 50) return "pilot";

  if (type === 36) return "sailing";

  if (type === 37) return "pleasure";

  if (type === 30) return "fishing";

  return "other";
}

/** Typical size when a ship hasn't reported its own, and its greys. */
const KINDS: Record<
  Kind,
  { length: number; beam: number; hull: number; deck: number }
> = {
  passenger: { length: 30, beam: 9, hull: 0xe9e9e9, deck: 0xd8d8d8 },
  cargo: { length: 160, beam: 27, hull: 0x383838, deck: 0x5e5e5e },
  tanker: { length: 140, beam: 22, hull: 0x2a2a2a, deck: 0x6a6a6a },
  tug: { length: 28, beam: 11, hull: 0x1f1f1f, deck: 0x8a8a8a },
  pilot: { length: 16, beam: 5, hull: 0x2b2b2b, deck: 0x8a8a8a },
  sailing: { length: 11, beam: 3.6, hull: 0xf0f0f0, deck: 0xcacaca },
  pleasure: { length: 10, beam: 3.4, hull: 0xf0f0f0, deck: 0xe6e6e6 },
  fishing: { length: 20, beam: 6, hull: 0x4a4a4a, deck: 0x7e7e7e },
  other: { length: 15, beam: 5, hull: 0x3f3f3f, deck: 0x8a8a8a },
};

const WHITE = 0xf2f2f2;

/** Container stacks, light to dark, so cargo ships still vary. */
const CONTAINERS = [0x9a9a9a, 0x7a7a7a, 0x5c5c5c, 0x8a8a8a];

/** A block on deck, from `from` to `to` of the length, bow (0) to stern (1). */
interface Part {
  from: number;
  to: number;
  /** Fraction of the beam. */
  width: number;
  height: number;
  color: number;
}

interface Hull {
  kind: Kind;
  length: number;
  beam: number;
  /** Deck height above the water. */
  freeboard: number;
  /** Hull centre from the AIS antenna: metres forward, metres to starboard. */
  offset: [number, number];
  /** The antenna, 0 at the bow to 1 at the stern, if the ship says. */
  antenna: number | null;
  hull: number;
  deck: number;
  parts: Part[];
  lights: Lights;
  /** Radians, so a harbour of boats doesn't bob in step. */
  phase: number;
  /** How far through lighting-up its crew switch the lights on, 0..1. */
  switchOn: number;
}

function lightsFor(
  parts: Part[],
  length: number,
  beam: number,
  freeboard: number
): Lights {
  const bridge = parts[0];
  const tallest = parts.reduce((a, b) => (b.height > a.height ? b : a));
  const top = freeboard + tallest.height + 0.3;

  const side = (sign: number): Point => [
    (sign * bridge.width * beam) / 2,
    freeboard + bridge.height * 0.7,
    (bridge.from - 0.5) * length,
  ];

  return {
    masthead: [0, top, (tallest.from - 0.5) * length],
    port: side(-1),
    starboard: side(1),
    stern: [0, freeboard + 0.3, length * 0.49],
    anchor: [0, top, ((tallest.from + tallest.to) / 2 - 0.5) * length],
  };
}

function partsFor(kind: Kind, length: number, mmsi: number): Part[] {
  const block = (
    from: number,
    to: number,
    width: number,
    height: number,
    color = WHITE
  ) => ({ from, to, width, height, color });

  switch (kind) {
    case "passenger":
      // Cook Strait ferries are mostly superstructure; harbour ferries less so.
      return length >= 80
        ? [block(0.1, 0.8, 0.92, length * 0.11)]
        : [block(0.25, 0.8, 0.85, Math.max(2.5, length * 0.1))];
    case "cargo":
      return [
        block(0.8, 0.93, 0.95, length * 0.13),
        block(
          0.12,
          0.78,
          0.9,
          length * 0.04,
          CONTAINERS[Math.floor(random(mmsi) * CONTAINERS.length)]
        ),
      ];
    case "tanker":
      return [block(0.82, 0.94, 0.95, length * 0.12)];
    case "tug":
      return [block(0.2, 0.5, 0.75, Math.max(3, length * 0.18))];
    case "pilot":
      return [block(0.25, 0.55, 0.75, Math.max(2, length * 0.16))];
    case "sailing":
      return [
        block(0.35, 0.6, 0.5, Math.max(0.6, length * 0.05)),
        // The mast.
        block(0.3, 0.32, 0.04, length * 1.4, 0xdddddd),
      ];
    case "pleasure":
      return [block(0.3, 0.65, 0.7, Math.max(1.2, length * 0.12))];
    case "fishing":
      return [block(0.2, 0.45, 0.8, Math.max(2.5, length * 0.15))];
    default:
      return [block(0.3, 0.6, 0.75, Math.max(2, length * 0.14))];
  }
}

function hullFor({ mmsi, type, dimension }: Vessel): Hull {
  const kind = kindOf(type);
  const typical = KINDS[kind];
  let length = typical.length;
  let beam = typical.beam;
  let offset: [number, number] = [0, 0];
  let antenna: number | null = null;

  if (dimension) {
    const [bow, stern, port, starboard] = dimension;

    // Some transponders are set up with nonsense; keep to plausible ships.
    if (bow + stern <= 400 && port + starboard <= 70) {
      length = Math.max(bow + stern, 3);
      beam = Math.max(port + starboard, 1);
      offset = [(bow - stern) / 2, (starboard - port) / 2];
      antenna = bow + stern > 0 ? bow / (bow + stern) : null;
    }
  }

  const freeboard =
    length >= 80 ? Math.min(14, length * 0.065) : Math.max(0.8, length * 0.09);

  const parts = partsFor(kind, length, mmsi);

  return {
    kind,
    length,
    beam,
    freeboard,
    offset,
    antenna,
    hull: typical.hull,
    deck: typical.deck,
    parts,
    lights: lightsFor(parts, length, beam, freeboard),
    phase: random(mmsi + 1) * 2 * Math.PI,
    switchOn: random(mmsi + 2),
  };
}

/** Where a ship is drawn: eased from report to report. */
interface Track {
  time: number;
  x: number;
  z: number;
  heading: number;
  /** Heading it was last given, for reports without one. */
  reported: number;
  /**
   * Whether it's ever been given a heading. Until then which way the hull
   * lies from the antenna is a guess, so it's centred on the antenna.
   */
  headed: boolean;
  /** Drawn minus reported, decaying to nothing. */
  error: [number, number, number];
}

const wrap = (angle: number) =>
  angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));

const radians = (degrees: number) => (degrees * Math.PI) / 180;

function colorAttribute(count: number) {
  const attribute = new InstancedBufferAttribute(
    new Float32Array(count * 3),
    3
  );

  return attribute;
}

function createMeshes() {
  const hullColors = colorAttribute(MAX_VESSELS);
  const deckColors = colorAttribute(MAX_VESSELS);
  const hullMaterial = new MeshStandardNodeMaterial({ roughness: 0.7 });
  hullMaterial.colorNode = mix(
    instancedBufferAttribute<"vec3">(hullColors, "vec3"),
    instancedBufferAttribute<"vec3">(deckColors, "vec3"),
    attribute<"float">("deck", "float")
  );

  const hulls = new InstancedMesh(
    createHullGeometry(),
    hullMaterial,
    MAX_VESSELS
  );

  const partColors = colorAttribute(MAX_VESSELS * MAX_PARTS_PER_VESSEL);
  const partMaterial = new MeshStandardNodeMaterial({ roughness: 0.6 });
  partMaterial.colorNode = instancedBufferAttribute<"vec3">(partColors, "vec3");

  const parts = new InstancedMesh(
    createBlockGeometry(),
    partMaterial,
    MAX_VESSELS * MAX_PARTS_PER_VESSEL
  );

  // Foam fading out behind and to the sides.
  const wakeMaterial = new MeshStandardNodeMaterial({
    roughness: 0.9,
    transparent: true,
    depthWrite: false,
  });

  const along = uv().y;
  const across = abs(uv().x.mul(2).sub(1));
  wakeMaterial.colorNode = vec3(0.94);
  wakeMaterial.opacityNode = float(1)
    .sub(along)
    .pow(2)
    .mul(float(1).sub(across.mul(across)))
    .mul(0.55);

  const wakes = new InstancedMesh(
    createWakeGeometry(),
    wakeMaterial,
    MAX_VESSELS
  );

  // Over the sea, which draws after the terrain.
  wakes.renderOrder = 2;

  for (const mesh of [hulls, parts, wakes]) {
    // Instances move every frame; their bounds would always be stale.
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.count = 0;
  }

  return { hulls, parts, wakes, hullColors, deckColors, partColors };
}

interface Detailed {
  /** What it was built for: rebuilt if the ship's size or name changes. */
  key: string;
  mesh: InstancedMesh;
  lights: Lights;
}

/**
 * Ships drawn in detail, built as they first come close and kept while
 * they're in the harbour: each its own mesh, as each is its own shape.
 */
function createDetailed() {
  const group = new Group();
  const { material, lit } = createModelMaterial({ roughness: 0.6 });
  const models = new Map<number, Detailed>();

  const keyOf = (vessel: Vessel, hull: Hull) =>
    `${vessel.name}|${hull.length}|${hull.beam}|${hull.antenna}`;

  /** A ship's model, if it's built or there's time this frame to build it. */
  const get = (vessel: Vessel, hull: Hull, budget: { builds: number }) => {
    const key = keyOf(vessel, hull);
    const model = models.get(vessel.mmsi);

    if (model?.key === key) return model;

    if (budget.builds <= 0) return null;
    budget.builds--;

    if (model) remove(vessel.mmsi);

    const { geometry, lights } = createShipModel({
      mmsi: vessel.mmsi,
      name: vessel.name,
      kind: hull.kind,
      length: hull.length,
      beam: hull.beam,
      freeboard: hull.freeboard,
      antenna: hull.antenna,
    });

    const mesh = new InstancedMesh(geometry, material, 1);
    mesh.name = vessel.name ?? String(vessel.mmsi);
    mesh.frustumCulled = false;
    mesh.visible = false;
    castsNearShadow(mesh);
    group.add(mesh);
    const built = { key, mesh, lights };
    models.set(vessel.mmsi, built);

    return built;
  };

  const remove = (mmsi: number) => {
    const model = models.get(mmsi);

    if (!model) return;
    group.remove(model.mesh);
    model.mesh.geometry.dispose();
    model.mesh.dispose();
    models.delete(mmsi);
  };

  /** Forgets ships no longer in the harbour. */
  const keep = (present: Set<number>) => {
    for (const mmsi of models.keys()) {
      if (!present.has(mmsi)) remove(mmsi);
    }
  };

  const dispose = () => {
    keep(new Set());
    material.dispose();
  };

  return { group, models, lit, get, keep, dispose };
}

/** Seconds since the scene clock's epoch (../clock.ts). */
const trailNow = uniform(0);

/** Fat line segments, each end with its time, so it can fade with age. */
function createTrailLines(count: number, material: TrailMaterial) {
  const geometry = new LineSegmentsGeometry();

  const segments = new InstancedInterleavedBuffer(
    new Float32Array(count * 6),
    6,
    1
  );

  geometry.setAttribute(
    "instanceStart",
    new InterleavedBufferAttribute(segments, 3, 0)
  );
  geometry.setAttribute(
    "instanceEnd",
    new InterleavedBufferAttribute(segments, 3, 3)
  );

  const times = new InstancedInterleavedBuffer(
    new Float32Array(count * 2),
    2,
    1
  );

  geometry.setAttribute(
    "instanceTimeStart",
    new InterleavedBufferAttribute(times, 1, 0)
  );
  geometry.setAttribute(
    "instanceTimeEnd",
    new InterleavedBufferAttribute(times, 1, 1)
  );
  geometry.instanceCount = 0;
  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  // After the sea (1) and wakes (2).
  lines.renderOrder = 3;

  return { lines, segments, times };
}

/**
 * Where ships under way have been: the reports, which change only when
 * they're polled, and from the latest report to where each ship is drawn,
 * which changes every frame.
 */
function createTrails() {
  const material = new TrailMaterial({
    color: TRAIL_COLOR,
    linewidth: TRAIL_WIDTH,
    worldUnits: false,
    transparent: true,
    depthWrite: false,
  });

  material.blending = NormalBlending;
  material.alphaToCoverage = false;
  // Its fog would be the template quad's, not the line's: hazed below.
  material.fog = false;

  // The template quad's y is below 0.5 at a segment's start, above at its end.
  const end = <T extends "float" | "vec3">(
    type: T,
    start: string,
    end: string
  ) =>
    select(
      positionGeometry.y.lessThan(0.5),
      attribute<T>(start, type),
      attribute<T>(end, type)
    );

  const at = varying(end("float", "instanceTimeStart", "instanceTimeEnd"));

  const seen = varying(
    hazeTransmittance(
      cameraPosition,
      end("vec3", "instanceStart", "instanceEnd")
    )
  );

  material.opacityNode = float(1)
    .sub(smoothstep(TAIL_HOLD, TAIL_HOLD + TAIL_FADE, trailNow.sub(at)))
    .mul(TRAIL_OPACITY)
    .mul(seen);

  return {
    material,
    past: createTrailLines(MAX_TRAIL_SEGMENTS, material),
    heads: createTrailLines(MAX_VESSELS, material),
  };
}

/** Navigation lights, as glowing sprites like the aircraft's. Steady. */
function createLights() {
  const light = new InstancedBufferAttribute(
    new Float32Array(MAX_LIGHTS * 4),
    4
  );

  const tint = new InstancedBufferAttribute(
    new Float32Array(MAX_LIGHTS * 3),
    3
  );

  const at = instancedBufferAttribute<"vec4">(light, "vec4");
  const position = at.xyz;

  const material = new SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  material.fog = false;
  material.positionNode = position;
  material.scaleNode = max(
    float(LIGHT_SIZE),
    cameraPosition.distance(position).mul(pixelAngle).mul(LIGHT_PIXELS)
  );
  const r = uv().sub(0.5).length().mul(2);
  // A hot core in a soft halo, as the obstruction lights.
  const glow = exp(r.mul(r).mul(-40)).add(exp(r.mul(-4.5)).mul(0.4));
  const edge = float(1).sub(smoothstep(0.85, 1, r));
  material.colorNode = instancedBufferAttribute<"vec3">(tint, "vec3")
    .mul(glow.mul(edge).mul(at.w).mul(3))
    .mul(sqrt(hazeTransmittance(cameraPosition, position)));

  const sprite = new Sprite(material);
  sprite.count = 0;
  sprite.frustumCulled = false;
  sprite.renderOrder = 10;

  return { sprite, light, tint };
}

/** 0..1: how much of a light's arc, from `from` to `to` radians off the bow, takes in `bearing`. */
function inArc(bearing: number, from: number, to: number) {
  const blend = (x: number) => Math.min(Math.max(x / ARC_BLEND + 0.5, 0), 1);

  return blend(bearing - from) * blend(to - bearing);
}

const matrix = new Matrix4();
const ship = new Matrix4();
const local = new Matrix4();
const rotation = new Quaternion();
const yaw = new Quaternion();
const tilt = new Quaternion();
const euler = new Euler();
const STILL = new Quaternion();
const point = new Vector3();
const scale = new Vector3();
const position = new Vector3();
const UP = new Vector3(0, 1, 0);
const color = new Color();

/**
 * Ships in Wellington Harbour at their live AIS positions, on their way
 * between reports by dead reckoning, with trails behind those under way.
 * Never on land: kept off the shore by half their beam, they don't reckon
 * their way aground, and a report well inland isn't shown. None show until
 * the shore has loaded. They bob a little with the sea's waves. `lights` (0..1), how far through
 * lighting-up, turns on their navigation lights ship by ship, for night.
 */
export function Vessels({
  index,
  sea,
  lights = 0,
}: {
  index: TileIndex;
  sea: OceanConditions;
  lights?: number;
}) {
  const vessels = useVessels();
  const shore = useShore(index);
  const { epoch } = useSeek();
  const meshes = useMemo(createMeshes, []);
  const trails = useMemo(createTrails, []);
  const sprites = useMemo(createLights, []);
  const spots = useFollowSpots("ship");
  const detailed = useMemo(createDetailed, []);
  const tracks = useRef(new Map<number, Track>());

  const waves = useMemo(() => {
    const period = peakPeriod(sea);

    return {
      omega: (2 * Math.PI) / period,
      length: (G * period * period) / (2 * Math.PI),
      height: significantHeight(sea),
      // Downwind, as the ocean's waves travel.
      bearing: radians(sea.windDirection + 180),
    };
  }, [sea]);

  const ships = useMemo(() => {
    if (!shore) return [];

    return vessels
      .flatMap((vessel) => {
        const at = nztmToWorld(index.manifest, ...vessel.position);

        if (!shore.toWater(...at)) return [];

        // Points off the sea are left out, and the trail broken there.
        const trail = vessel.trail.map(
          ([e, n, time]): [number, number, number] | null => {
            const water = shore.toWater(...nztmToWorld(index.manifest, e, n));

            return water ? [...water, (time - epoch) / 1000] : null;
          }
        );

        // The trail reaches the ship if it's under way from the last point.
        const last = vessel.trail[vessel.trail.length - 1];
        const underWay = vessel.speed > UNDER_WAY && vessel.course !== null;
        const hull = hullFor(vessel);
        const course = radians(vessel.course ?? 0);

        return [
          {
            vessel,
            hull,
            at,
            // How far it can reckon its way on before running aground.
            reach: underWay
              ? shore.reach(
                  ...at,
                  Math.sin(course),
                  -Math.cos(course),
                  vessel.speed * MAX_DEAD_RECKONING,
                  hull.beam / 2 + BERTH_GAP
                )
              : 0,
            trail,
            head:
              underWay && last?.[2] === vessel.time
                ? trail[trail.length - 1]
                : null,
          },
        ];
      })
      .slice(0, MAX_VESSELS);
  }, [vessels, index, epoch, shore]);

  useFollowCandidates(
    "ship",
    useMemo(
      () =>
        ships.map(({ vessel }): Candidate => ({
          id: String(vessel.mmsi),
          label: vessel.name ?? `MMSI ${vessel.mmsi}`,
          moving: vessel.speed > UNDER_WAY,
        })),
      [ships]
    )
  );

  useEffect(() => {
    const { past, heads } = trails;
    const positions = past.segments.array;
    const stamps = past.times.array;
    let n = 0;

    for (const { trail } of ships) {
      for (let i = 0; i < trail.length - 1 && n < MAX_TRAIL_SEGMENTS; i++) {
        const a = trail[i];
        const b = trail[i + 1];

        if (!a || !b) continue;
        const [ax, az, at] = a;
        const [bx, bz, bt] = b;

        if (bt - at > TRAIL_GAP / 1000) continue;
        positions.set([ax, TRAIL_HEIGHT, az, bx, TRAIL_HEIGHT, bz], n * 6);
        stamps.set([at, bt], n * 2);
        n++;
      }
    }

    past.segments.needsUpdate = past.times.needsUpdate = true;
    past.lines.geometry.instanceCount = n;

    // Heads start at the latest report; where they end is set each frame.
    // Without one, long faded.
    const headStamps = heads.times.array;
    ships.forEach(({ head }, i) => {
      headStamps.set(head ? [head[2], FUTURE] : [-FUTURE, -FUTURE], i * 2);
    });
    heads.times.needsUpdate = true;
  }, [ships, trails]);

  useEffect(() => {
    const { hullColors, deckColors, partColors } = meshes;
    let part = 0;
    ships.forEach(({ hull }, i) => {
      color.setHex(hull.hull).toArray(hullColors.array, i * 3);
      color.setHex(hull.deck).toArray(deckColors.array, i * 3);

      for (const { color: hex } of hull.parts) {
        color.setHex(hex).toArray(partColors.array, part++ * 3);
      }
    });
    hullColors.needsUpdate = deckColors.needsUpdate = true;
    partColors.needsUpdate = true;

    const present = new Set(ships.map(({ vessel }) => vessel.mmsi));

    for (const mmsi of tracks.current.keys()) {
      if (!present.has(mmsi)) tracks.current.delete(mmsi);
    }

    detailed.keep(present);
  }, [ships, meshes, detailed]);

  useEffect(() => {
    detailed.lit.value = lights;
  }, [detailed, lights]);

  useEffect(
    () => () => {
      for (const mesh of [meshes.hulls, meshes.parts, meshes.wakes]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.dispose();
      }

      for (const { lines } of [trails.past, trails.heads]) {
        lines.geometry.dispose();
      }

      trails.material.dispose();
      sprites.sprite.material.dispose();
      detailed.dispose();
    },
    [meshes, trails, sprites, detailed]
  );

  useFrame(({ camera, clock }, delta) => {
    if (!shore) return;
    const { hulls, parts, wakes } = meshes;
    const now = sceneNow();
    // Everything afloat rides the tide.
    const sea = seaLevel.value;
    const decay = Math.exp(-delta / SETTLE);
    let partCount = 0;
    let wakeCount = 0;
    trailNow.value = (now - epoch) / 1000;
    const heads = trails.heads.segments.array;
    const { light, tint } = sprites;
    let lit = 0;
    const watched = followed("ship");
    spots.begin();
    const budget = { builds: BUILDS_PER_FRAME };
    const shown = new Set<number>();

    const show = (at: Point, tone: Color, intensity: number) => {
      if (intensity <= 0 || lit >= MAX_LIGHTS) return;
      point.set(...at).applyMatrix4(ship);
      light.setXYZW(lit, point.x, point.y, point.z, intensity);
      tint.setXYZ(lit, tone.r, tone.g, tone.b);
      lit++;
    };

    ships.forEach(({ vessel, hull, at, reach, head }, i) => {
      const { course: reported } = vessel;
      const underWay = vessel.speed > UNDER_WAY && reported !== null;
      let track = tracks.current.get(vessel.mmsi);

      // Where the report puts it now, carrying on at its course and speed.
      let [x, z] = at;

      if (underWay) {
        const age = Math.min(
          Math.max((now - vessel.time) / 1000, 0),
          MAX_DEAD_RECKONING
        );

        const course = radians(reported);
        const run = Math.min(vessel.speed * age, reach);
        x += Math.sin(course) * run;
        z -= Math.cos(course) * run;
      }

      // Moored ships' courses are noise; keep the last heading we had.
      const given = vessel.heading ?? (underWay ? vessel.course : null);
      const heading = given !== null ? radians(given) : (track?.reported ?? 0);

      if (!track) {
        track = {
          time: vessel.time,
          x,
          z,
          heading,
          reported: heading,
          headed: given !== null,
          error: [0, 0, 0],
        };
        tracks.current.set(vessel.mmsi, track);
      } else if (track.time !== vessel.time) {
        // New report: ease from where it's drawn onto where it should be.
        track.error = [track.x - x, track.z - z, wrap(track.heading - heading)];

        if (Math.hypot(track.error[0], track.error[1]) > SNAP) {
          track.error = [0, 0, 0];
        }

        track.time = vessel.time;
      } else {
        const [ex, ez, eh] = track.error;
        track.error = [ex * decay, ez * decay, eh * decay];
      }

      track.reported = heading;
      track.headed ||= given !== null;
      track.x = x + track.error[0];
      track.z = z + track.error[1];
      track.heading = heading + track.error[2];

      const { length, beam, freeboard } = hull;
      const offset = track.headed ? hull.offset : [0, 0];
      // Bow along (sin, -cos) in world x/z; starboard along (cos, sin).
      let h = track.heading;
      let forward = [Math.sin(h), -Math.cos(h)];
      let starboard = [Math.cos(h), Math.sin(h)];

      // All along the keel, as far as the ends' curves, half the beam off.
      const centre = () =>
        shore.toWater(
          track.x + forward[0] * offset[0] + starboard[0] * offset[1],
          track.z + forward[1] * offset[0] + starboard[1] * offset[1],
          beam / 2 + BERTH_GAP,
          forward[0],
          forward[1],
          Math.max(length - beam, 0) / 2
        );

      let water = centre();

      if (!water) {
        // Eased across a headland: go straight to the report instead.
        track.error = [0, 0, 0];
        track.x = x;
        track.z = z;
        track.heading = h = heading;
        forward = [Math.sin(h), -Math.cos(h)];
        starboard = [Math.cos(h), Math.sin(h)];
        water = centre();
      }

      if (!water) {
        // Nowhere at sea to put it: keep its instances, out of sight.
        matrix.makeScale(0, 0, 0);
        hulls.setMatrixAt(i, matrix);

        for (let p = 0; p < hull.parts.length; p++) {
          parts.setMatrixAt(partCount++, matrix);
        }

        const [hx, hz] = head ?? [track.x, track.z];
        heads.set([hx, TRAIL_HEIGHT, hz, hx, TRAIL_HEIGHT, hz], i * 6);

        return;
      }

      const [cx, cz] = water;
      // The antenna goes where the hull's been put.
      track.x = cx - forward[0] * offset[0] - starboard[0] * offset[1];
      track.z = cz - forward[1] * offset[0] - starboard[1] * offset[1];

      // Behind a ship under way, from its latest report to where it's drawn.
      const [hx, hz] = head ?? [track.x, track.z];
      heads.set([hx, TRAIL_HEIGHT, hz, track.x, TRAIL_HEIGHT, track.z], i * 6);

      // Long hulls span the waves and ride them out; small boats follow them.
      const phase = clock.elapsedTime * waves.omega + hull.phase;
      const along = 1 / (1 + (length / waves.length) ** 2);
      const across = 1 / (1 + (beam / waves.length) ** 2);
      const slope = (BOB * Math.PI * waves.height) / waves.length;
      // Pitching head to sea, rolling beam on.
      const relative = h - waves.bearing;
      const heave = ((BOB * waves.height) / 2) * along * Math.sin(phase);

      const pitch =
        slope *
        along *
        (0.3 + 0.7 * Math.abs(Math.cos(relative))) *
        Math.cos(phase);

      const roll =
        slope *
        across *
        (0.3 + 0.7 * Math.abs(Math.sin(relative))) *
        Math.cos(phase + 0.6);

      yaw.setFromAxisAngle(UP, -h);
      tilt.setFromEuler(euler.set(pitch, 0, roll));
      rotation.multiplyQuaternions(yaw, tilt);
      ship.compose(
        position.set(cx, sea + heave, cz),
        rotation,
        scale.set(1, 1, 1)
      );

      const model = isNear(length, camera.position.distanceTo(position))
        ? detailed.get(vessel, hull, budget)
        : null;

      if (model) {
        model.mesh.setMatrixAt(0, ship);
        model.mesh.instanceMatrix.needsUpdate = true;
        model.mesh.visible = true;
        shown.add(vessel.mmsi);
      }

      matrix.multiplyMatrices(ship, local.makeScale(beam, freeboard, length));
      hulls.setMatrixAt(i, model ? HIDDEN : matrix);
      spots.add(String(vessel.mmsi), cx, sea + heave + freeboard, cz, length);

      if (String(vessel.mmsi) === watched) {
        publish({
          x: cx,
          y: sea + heave + freeboard,
          z: cz,
          heading: h,
          length,
          speed: underWay ? vessel.speed : 0,
        });
      }

      for (const { from, to, width, height } of hull.parts) {
        const aft = ((from + to) / 2 - 0.5) * length;
        local.compose(
          position.set(0, freeboard, aft),
          STILL,
          scale.set(width * beam, height, (to - from) * length)
        );
        parts.setMatrixAt(
          partCount++,
          model ? HIDDEN : matrix.multiplyMatrices(ship, local)
        );
      }

      const on = lights > hull.switchOn ? 1 : 0;

      if (on > 0) {
        // Off the bow, positive to starboard, as seen from the camera.
        const dx = camera.position.x - cx;
        const dz = camera.position.z - cz;

        const bearing = Math.atan2(
          dx * starboard[0] + dz * starboard[1],
          dx * forward[0] + dz * forward[1]
        );

        const at = model?.lights ?? hull.lights;

        if (underWay) {
          show(
            at.masthead,
            NAV_WHITE,
            on * inArc(bearing, -SIDELIGHT_ARC, SIDELIGHT_ARC)
          );
          show(at.port, NAV_RED, on * inArc(bearing, -SIDELIGHT_ARC, 0));
          show(at.starboard, NAV_GREEN, on * inArc(bearing, 0, SIDELIGHT_ARC));
          show(
            at.stern,
            NAV_WHITE,
            on * (1 - inArc(bearing, -SIDELIGHT_ARC, SIDELIGHT_ARC))
          );
        } else {
          show(at.anchor, NAV_WHITE, on * ANCHOR_LIGHT);
        }
      }

      if (underWay) {
        const wake = Math.min(vessel.speed * WAKE_SECONDS, length * 5 + 40);
        matrix.compose(
          position.set(
            cx - forward[0] * (length / 2),
            sea + 0.3,
            cz - forward[1] * (length / 2)
          ),
          yaw,
          scale.set(beam, 1, wake)
        );
        wakes.setMatrixAt(wakeCount++, matrix);
      }
    });

    for (const [mmsi, { mesh }] of detailed.models) {
      if (!shown.has(mmsi)) mesh.visible = false;
    }

    hulls.count = ships.length;
    parts.count = partCount;
    wakes.count = wakeCount;

    for (const mesh of [hulls, parts, wakes]) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    sprites.sprite.count = lit;
    sprites.sprite.visible = lit > 0;
    light.needsUpdate = tint.needsUpdate = true;
    trails.heads.segments.needsUpdate = true;
    trails.heads.lines.geometry.instanceCount = ships.length;
    trails.past.lines.position.y = trails.heads.lines.position.y = sea;
  });

  return (
    <>
      <primitive object={meshes.hulls} name="ships" />
      <primitive object={meshes.parts} />
      <primitive object={meshes.wakes} />
      <primitive object={trails.past.lines} name="ship trails" />
      <primitive object={trails.heads.lines} />
      <primitive object={sprites.sprite} name="ship lights" />
      <primitive object={detailed.group} name="detailed ships" />
    </>
  );
}
