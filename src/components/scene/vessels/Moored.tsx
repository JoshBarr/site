import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from "three/webgpu";
import { attribute, mix, vec3 } from "three/tsl";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { random } from "../landmarks/common";
import { seaLevel } from "../environment";
import { createModelMaterial, HIDDEN, isNear, NearModels } from "../models/lod";
import { BERTHS, KINDS, PLACES } from "./berths";
import { OCCUPANCY, SAILING } from "./moorings";
import { createBlockGeometry, createHullGeometry } from "./geometry";
import { createShipModel } from "./models";
import type { Shore } from "./shore";

// Yachts and launches in the marinas and on the moorings, most of which
// never send AIS, or have it off while they're moored: generic boats, not
// real ones, in a place's berths at how full it was found (moorings.ts).
// Which berths have one in is the same every visit. In a pen or between
// piles a boat lies along its berth; on a buoy, head to wind, downwind of it.
// They ride the tide, but not the waves: the marinas are sheltered.

/** Nearer than this to a moored ship the AIS has, m, a berth's left to it. */
const TAKEN = 6;

/** A berth whose middle is further inland than this, m, isn't drawn. */
const ASHORE = -2;

/** Of its berth's length, a boat's. */
const FILLS = [0.72, 0.92] as const;

/** Lengths on a swing mooring, m. */
const SWING_LENGTH = [7, 12] as const;

/** Of a boat's length, its beam. */
const BEAM = 0.34;

/** Clear of a pen's sides, m: fenders. */
const FENDERS = 0.6;

/** A boat on a buoy lies this far downwind of it past half its length, m. */
const SCOPE = 4;

/** The size the detailed models are built at; each boat scales one. */
const MODEL_LENGTH = 10;
const MODEL_BEAM = MODEL_LENGTH * BEAM;

/** As the AIS boats' (Vessels.tsx). */
const freeboardOf = (length: number) => Math.max(0.8, length * 0.09);

/** Most of each model drawn in detail at once. */
const NEAR_CAPACITY = 128;

const HULL = 0xf0f0f0;
const DECK = 0xd2d2d2;
const HOUSE = 0xe4e4e4;

interface Boat {
  e: number;
  n: number;
  sailing: boolean;
  length: number;
  beam: number;
  /** Compass bearing of its bow, radians; null on a buoy, where it swings. */
  bearing: number | null;
}

/** Every berth with a boat in it, and the boat. */
const BOATS: Boat[] = BERTHS.flatMap(
  ([e, n, bearing, length, width, kind, place], i): Boat[] => {
    if (random(i * 4) >= OCCUPANCY[PLACES[place]]) return [];
    const swings = KINDS[kind] === "swing";
    const size = random(i * 4 + 2);

    const boatLength = swings
      ? SWING_LENGTH[0] + size * (SWING_LENGTH[1] - SWING_LENGTH[0])
      : length * (FILLS[0] + size * (FILLS[1] - FILLS[0]));

    const beam = swings
      ? boatLength * BEAM
      : Math.min(boatLength * BEAM, Math.max(width - FENDERS, 1.5));

    // Bow in or stern in, either way along the pen.
    const flip = random(i * 4 + 3) < 0.5 ? 180 : 0;

    return [
      {
        e,
        n,
        sailing: random(i * 4 + 1) < SAILING,
        length: boatLength,
        beam,
        bearing: swings ? null : ((bearing + flip) * Math.PI) / 180,
      },
    ];
  }
);

/**
 * The simple shape's blocks, as the AIS boats': a cabin, and a yacht's mast.
 * Each is [from, to] of the length bow to stern, width of the beam, height.
 */
function blocksOf({
  sailing,
  length,
}: Boat): [number, number, number, number][] {
  return sailing
    ? [
        [0.35, 0.6, 0.5, Math.max(0.6, length * 0.05)],
        [0.3, 0.32, 0.04, length * 1.4],
      ]
    : [[0.3, 0.65, 0.7, Math.max(1.2, length * 0.12)]];
}

const hex = (color: number) =>
  vec3(
    ((color >> 16) & 255) / 255,
    ((color >> 8) & 255) / 255,
    (color & 255) / 255
  );

/** The simple shapes: hulls, and cabins and masts. */
function createSimple(count: number) {
  const hullMaterial = new MeshStandardNodeMaterial({ roughness: 0.7 });
  hullMaterial.colorNode = mix(
    hex(HULL),
    hex(DECK),
    attribute<"float">("deck", "float")
  );

  const hulls = new InstancedMesh(createHullGeometry(), hullMaterial, count);
  const partMaterial = new MeshStandardNodeMaterial({ roughness: 0.6 });
  partMaterial.colorNode = hex(HOUSE);

  const parts = new InstancedMesh(
    createBlockGeometry(),
    partMaterial,
    count * 2
  );

  for (const mesh of [hulls, parts]) {
    // Over the whole region: one box round them all would never be culled.
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.count = 0;
  }

  return { hulls, parts };
}

/** A detailed yacht and launch, built once at MODEL_LENGTH and scaled. */
function createDetailed() {
  // Their windows stay dark: nobody's aboard.
  const { material } = createModelMaterial({ roughness: 0.6 });

  const model = (kind: "sailing" | "pleasure") =>
    new NearModels(
      createShipModel({
        mmsi: 0,
        name: null,
        kind,
        length: MODEL_LENGTH,
        beam: MODEL_BEAM,
        freeboard: freeboardOf(MODEL_LENGTH),
        antenna: null,
      }).geometry,
      material,
      NEAR_CAPACITY
    );

  return { material, sailing: model("sailing"), launch: model("pleasure") };
}

const UP = new Vector3(0, 1, 0);
const yaw = new Quaternion();
const position = new Vector3();
const scale = new Vector3();
const local = new Matrix4();
const near = new Matrix4();
const world = new Vector3();
const STILL = new Quaternion();

/** A boat where it's drawn, its matrices at sea level 0. */
interface Placed {
  boat: Boat;
  x: number;
  z: number;
  /** Its simple hull. */
  hull: Matrix4;
  /** Its simple blocks, at `first` on in the parts mesh. */
  parts: Matrix4[];
  first: number;
  /** Its detailed model. */
  model: Matrix4;
  /** Whether it's drawn in detail now. */
  near: boolean;
}

function place(
  index: TileIndex,
  shore: Shore,
  taken: [number, number][],
  windDirection: number
) {
  const wind = (windDirection * Math.PI) / 180;
  const placed: Placed[] = [];
  let first = 0;

  for (const boat of BOATS) {
    let [x, z] = nztmToWorld(index.manifest, boat.e, boat.n);

    if (shore.distance(x, z) < ASHORE) continue;

    if (taken.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < TAKEN)) continue;
    const heading = boat.bearing ?? wind;

    if (boat.bearing === null) {
      // Astern of its buoy, as it heads into the wind.
      const scope = boat.length / 2 + SCOPE;
      x -= Math.sin(heading) * scope;
      z += Math.cos(heading) * scope;
    }

    // Bow along (sin, -cos) in world x/z, as the AIS boats'.
    yaw.setFromAxisAngle(UP, -heading);

    const frame = new Matrix4().compose(
      position.set(x, 0, z),
      yaw,
      scale.set(1, 1, 1)
    );

    const { length, beam } = boat;
    const freeboard = freeboardOf(length);

    const hull = new Matrix4().multiplyMatrices(
      frame,
      local.makeScale(beam, freeboard, length)
    );

    const parts = blocksOf(boat).map(([from, to, width, height]) =>
      new Matrix4().multiplyMatrices(
        frame,
        local.compose(
          position.set(0, freeboard, ((from + to) / 2 - 0.5) * length),
          STILL,
          scale.set(width * beam, height, (to - from) * length)
        )
      )
    );

    const model = new Matrix4().multiplyMatrices(
      frame,
      local.makeScale(
        beam / MODEL_BEAM,
        length / MODEL_LENGTH,
        length / MODEL_LENGTH
      )
    );

    placed.push({ boat, x, z, hull, parts, first, model, near: false });
    first += parts.length;
  }

  return placed;
}

/** Draws a boat's simple shape, or hides it while it's drawn in detail. */
function setSimple(
  { hulls, parts }: ReturnType<typeof createSimple>,
  item: Placed,
  i: number
) {
  hulls.setMatrixAt(i, item.near ? HIDDEN : item.hull);
  item.parts.forEach((matrix, p) =>
    parts.setMatrixAt(item.first + p, item.near ? HIDDEN : matrix)
  );
}

/**
 * Moored yachts and launches in the berths `BOATS` fills, less those on land
 * by `shore` and those `taken` by moored ships the AIS has (their world x,
 * z). A boat on a buoy heads into `windDirection` (degrees, where it's from).
 */
export function Moored({
  index,
  shore,
  taken,
  windDirection,
}: {
  index: TileIndex;
  shore: Shore;
  taken: [number, number][];
  windDirection: number;
}) {
  const simple = useMemo(() => createSimple(BOATS.length), []);
  const detailed = useMemo(createDetailed, []);

  const placed = useMemo(
    () => place(index, shore, taken, windDirection),
    [index, shore, taken, windDirection]
  );

  useEffect(() => {
    placed.forEach((item, i) => setSimple(simple, item, i));
    simple.hulls.count = placed.length;
    simple.parts.count = placed.reduce((n, { parts }) => n + parts.length, 0);
    simple.hulls.instanceMatrix.needsUpdate = true;
    simple.parts.instanceMatrix.needsUpdate = true;
  }, [placed, simple]);

  useEffect(
    () => () => {
      for (const mesh of [simple.hulls, simple.parts]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.dispose();
      }

      detailed.sailing.dispose();
      detailed.launch.dispose();
      detailed.material.dispose();
    },
    [simple, detailed]
  );

  useFrame(({ camera }) => {
    const { hulls, parts } = simple;
    const { sailing, launch } = detailed;
    // Afloat, they ride the tide.
    const sea = seaLevel.value;
    hulls.position.y = parts.position.y = sea;
    sailing.begin();
    launch.begin();
    let changed = false;

    placed.forEach((item, i) => {
      const { boat } = item;
      world.set(item.x, sea, item.z);
      let close = isNear(boat.length, camera.position.distanceTo(world));

      if (close) {
        near.copy(item.model);
        near.elements[13] += sea;
        // Out of room, it stays simple.
        close = (boat.sailing ? sailing : launch).add(near);
      }

      if (close === item.near) return;
      item.near = close;
      setSimple(simple, item, i);
      changed = true;
    });

    if (changed) {
      hulls.instanceMatrix.needsUpdate = true;
      parts.instanceMatrix.needsUpdate = true;
    }

    sailing.end();
    launch.end();
  });

  return (
    <>
      <primitive object={simple.hulls} name="moored boats" />
      <primitive object={simple.parts} />
      <primitive object={detailed.sailing.mesh} name="moored yachts" />
      <primitive object={detailed.launch.mesh} name="moored launches" />
    </>
  );
}
