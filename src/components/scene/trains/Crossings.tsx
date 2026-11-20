import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  DoubleSide,
  InstancedBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
  type Node,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
} from "three/webgpu";
import {
  attribute,
  cameraPosition,
  faceDirection,
  float,
  floor,
  fract,
  instancedBufferAttribute,
  max,
  mix,
  normalGeometry,
  positionGeometry,
  select,
  smoothstep,
  sqrt,
  step,
  transformNormalToView,
  uniform,
  uniformArray,
  varying,
  vec3,
} from "three/tsl";
import { sceneNow, useSeek } from "../clock";
import { hazeTransmittance } from "../haze";
import { lampGlow } from "../lamps";
import { pixelAngle, rotateZ } from "../landmarks/common";
import { castsNearShadow } from "../landmarks/nearShadow";
import {
  ARM,
  BLACK,
  BOARD,
  createDeckGeometry,
  createMastGeometry,
  LAMP_A,
  LAMP_B,
  LAMP_HEIGHT,
  LAMP_OUT,
  PIVOT,
} from "./crossingGeometry";
import {
  ARMS_AFTER,
  ARMS_FALL,
  ARMS_RISE,
  type Crossing,
  FLASH_PERIOD,
  flashing,
  type Watch,
} from "./crossingWatch";

/**
 * Masts and decks are drawn with the camera this near a crossing, m:
 * beyond, a mast is a pixel or two.
 */
const RANGE = 2500;

/** Their lamps' glow shows from this far, m, fading out over the last third. */
const GLOW_RANGE = 9000;

/** How far up the arms stand when they're raised, radians from level. */
const RAISED = (88.5 * Math.PI) / 180;

/** A path's masts and lamps against a road's. */
const PATH_SCALE = 0.72;

/** The arm's bands of red and white, m. */
const BAND = 0.6;

/** The lamps' glow: never smaller than this many pixels, nor this, m. */
const GLOW_PIXELS = 7;
const GLOW_SIZE = 0.9;

/** Each lamp takes this much of its cycle to come up and to die away. */
const LAMP_EDGE = 0.07;

const RED: [number, number, number] = [1, 0.07, 0.03];

/**
 * What every crossing's shader goes by: the scene's clock, s since its
 * epoch, and when each crossing's lights last came on and went off.
 */
function createSignals(count: number) {
  const zeros = () => Array.from({ length: Math.max(count, 1) }, () => 0);

  return {
    clock: uniform(0),
    ons: uniformArray<"float">(zeros(), "float"),
    offs: uniformArray<"float">(zeros(), "float"),
  };
}

type Signals = ReturnType<typeof createSignals>;

/** A crossing's state in the shader, from its index: see crossingWatch.ts. */
function sequence({ clock, ons, offs }: Signals, index: Node<"float">) {
  const on = ons.element(index.toInt());
  const off = offs.element(index.toInt());

  const down = clock
    .sub(on)
    .sub(ARMS_AFTER)
    .div(ARMS_FALL)
    .clamp(0, 1)
    .mul(float(1).sub(clock.sub(off).div(ARMS_RISE).clamp(0, 1)));

  return {
    /** How far down its arms are, 0..1, eased. */
    lowered: smoothstep(0, 1, down),
    /** 1 while its lights flash. */
    flashes: step(on, clock).mul(step(clock, off.add(ARMS_RISE))),
    /** How far through a flash of both lamps, 0..1. */
    cycle: fract(clock.sub(on).div(FLASH_PERIOD)),
  };
}

/** How bright a lamp is, `turn` of a cycle after the first one's lit. */
function lamp(cycle: Node<"float">, turn: number) {
  const t = fract(cycle.add(1 - turn));

  return smoothstep(0, LAMP_EDGE, t).mul(
    float(1).sub(smoothstep(0.5, 0.5 + LAMP_EDGE, t))
  );
}

function createMasts(crossings: Crossing[], signals: Signals) {
  const masts = crossings.flatMap((crossing, index) =>
    crossing.masts.map((mast) => ({ mast, index, path: crossing.path }))
  );

  const places = new Float32Array(masts.length * 4);
  const facings = new Float32Array(masts.length * 4);

  masts.forEach(({ mast, index, path }, i) => {
    places.set([mast.x, mast.y, mast.z, index], i * 4);
    facings.set([...mast.facing, mast.arm, path ? PATH_SCALE : 1], i * 4);
  });

  const geometry = createMastGeometry();
  geometry.setAttribute("place", new InstancedBufferAttribute(places, 4));
  geometry.setAttribute("facing", new InstancedBufferAttribute(facings, 4));

  const place = attribute<"vec4">("place", "vec4");
  const facing = attribute<"vec4">("facing", "vec4");
  const swing = attribute<"vec2">("swing", "vec2");
  const part = attribute<"float">("part", "float");
  const size = facing.w;
  const reach = facing.z;
  const state = sequence(signals, place.w);

  // The arm: laid out to its length, swung up about the pivot, and not
  // there at all where there's none.
  const angle = float(1).sub(state.lowered).mul(RAISED);
  const metres = swing.y.mul(reach).div(size);

  const swung = rotateZ(
    vec3(positionGeometry.x.add(metres), positionGeometry.yz),
    angle
  )
    .mul(step(0.01, reach))
    .add(vec3(...PIVOT));

  // Too far off to see, a mast's drawn as nothing.
  const shown = step(cameraPosition.distance(place.xyz), RANGE);
  const local = mix(positionGeometry, swung, swing.x).mul(size).mul(shown);

  // Into the world: x across to the road's middle, z at those coming.
  const turned = (v: Node<"vec3">) =>
    vec3(
      v.x.mul(facing.y).add(v.z.mul(facing.x)),
      v.y,
      v.z.mul(facing.y).sub(v.x.mul(facing.x))
    );

  const material = new MeshStandardNodeMaterial({
    roughness: 0.7,
    side: DoubleSide,
  });

  material.positionNode = turned(local).add(place.xyz);

  const normal = varying(
    transformNormalToView(
      turned(mix(normalGeometry, rotateZ(normalGeometry, angle), swing.x))
    )
  );

  material.normalNode = normal.normalize().mul(faceDirection);

  const isPart = (p: number) =>
    part.greaterThan(p - 0.5).and(part.lessThan(p + 0.5));

  // Bands of red and white along the arm, by the metre.
  const along = varying(metres.mul(size));
  const band = fract(floor(along.div(BAND)).mul(0.5)).greaterThan(0.25);

  material.colorNode = select(
    isPart(ARM),
    select(band, vec3(0.85), vec3(0.62, 0.03, 0.03)),
    select(
      isPart(BOARD),
      vec3(0.85),
      select(
        isPart(BLACK),
        vec3(0.025),
        select(part.greaterThan(LAMP_A - 0.5), vec3(0.2, 0.01, 0.01), vec3(0.5))
      )
    )
  );

  const flashes = varying(state.flashes);
  const cycle = varying(state.cycle);

  material.emissiveNode = vec3(...RED).mul(
    select(
      isPart(LAMP_A),
      lamp(cycle, 0),
      select(isPart(LAMP_B), lamp(cycle, 0.5), float(0))
    )
      .mul(flashes)
      .mul(3)
  );

  const mesh = new Mesh(geometry, material);
  mesh.name = "level crossing masts";
  mesh.count = masts.length;
  // Masts are placed in the shader; the geometry's bounds mean nothing.
  mesh.frustumCulled = false;
  castsNearShadow(mesh);

  return mesh;
}

/** The lamps' glow, a sprite to each: what's seen of them from far off. */
function createGlow(crossings: Crossing[], signals: Signals) {
  const lamps = crossings.flatMap((crossing, index) =>
    crossing.masts.flatMap(({ x, y, z, facing: [fx, fz] }) => {
      const size = crossing.path ? PATH_SCALE : 1;

      return [-1, 1].map((side, turn) => ({
        // Out along the mast's own x: (fz, -fx) in the world.
        at: [
          x + fz * side * LAMP_OUT * size,
          y + LAMP_HEIGHT * size,
          z - fx * side * LAMP_OUT * size,
          index,
        ],
        turn: turn * 0.5,
        size,
      }));
    })
  );

  const light = instancedBufferAttribute<"vec4">(
    new InstancedBufferAttribute(
      new Float32Array(lamps.flatMap(({ at }) => at)),
      4
    ),
    "vec4"
  );

  // Its turn in the cycle, and its size against a road's.
  const kind = instancedBufferAttribute<"vec2">(
    new InstancedBufferAttribute(
      new Float32Array(lamps.flatMap(({ turn, size }) => [turn, size])),
      2
    ),
    "vec2"
  );

  const state = sequence(signals, light.w);
  const position = light.xyz;
  const distance = cameraPosition.distance(position);

  const material = new SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  material.fog = false;
  material.positionNode = position;
  material.scaleNode = max(
    float(GLOW_SIZE),
    distance.mul(pixelAngle).mul(GLOW_PIXELS)
  ).mul(kind.y);

  const lit = varying(
    state.flashes
      .mul(
        select(
          kind.x.greaterThan(0.25),
          lamp(state.cycle, 0.5),
          lamp(state.cycle, 0)
        )
      )
      .mul(float(1).sub(smoothstep(GLOW_RANGE * 0.67, GLOW_RANGE, distance)))
  );

  material.colorNode = vec3(...RED)
    .mul(lampGlow(0.4).mul(lit).mul(3))
    .mul(sqrt(hazeTransmittance(cameraPosition, position)));

  const sprite = new Sprite(material);
  sprite.name = "level crossing lamps";
  sprite.count = lamps.length;
  sprite.frustumCulled = false;
  sprite.renderOrder = 10;
  sprite.visible = false;

  return sprite;
}

function createDecks(crossings: Crossing[]) {
  const mesh = new Mesh(
    createDeckGeometry(crossings),
    new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 })
  );

  mesh.name = "level crossing decks";
  mesh.receiveShadow = true;
  // One mesh for the lot, the length of the map: shown by range instead.
  mesh.frustumCulled = false;

  return mesh;
}

const eye = new Vector3();

/**
 * The level crossings: each road's deck over the tracks, and where there
 * are lights, the masts either side with their lamps, bells and barrier
 * arms, flashing and falling as `watch` says the trains require.
 */
export function Crossings({ watch }: { watch: Watch }) {
  const { epoch } = useSeek();

  const built = useMemo(() => {
    const signals = createSignals(watch.crossings.length);

    return {
      signals,
      masts: createMasts(watch.crossings, signals),
      glow: createGlow(watch.crossings, signals),
      decks: createDecks(watch.crossings),
    };
  }, [watch]);

  useEffect(
    () => () => {
      built.masts.geometry.dispose();
      built.masts.material.dispose();
      built.glow.material.dispose();
      built.decks.geometry.dispose();
      built.decks.material.dispose();
    },
    [built]
  );

  // The clock set to another time: what was flashing then isn't now.
  useEffect(() => watch.reset(), [watch, epoch]);

  useFrame(({ camera }) => {
    const { signals, masts, glow, decks } = built;
    const now = (sceneNow() - epoch) / 1000;
    let nearest = Infinity;
    let lit = false;

    camera.getWorldPosition(eye);
    signals.clock.value = now;

    for (const [i, { on, off }] of watch.signals.entries()) {
      const { x, y, z } = watch.crossings[i];

      signals.ons.array[i] = on;
      signals.offs.array[i] = off;
      nearest = Math.min(nearest, eye.distanceTo({ x, y, z }));
      lit ||= flashing(on, off, now);
    }

    masts.visible = decks.visible = nearest < RANGE;
    glow.visible = lit && nearest < GLOW_RANGE;
  });

  return (
    <>
      <primitive object={built.decks} />
      <primitive object={built.masts} />
      <primitive object={built.glow} />
    </>
  );
}
