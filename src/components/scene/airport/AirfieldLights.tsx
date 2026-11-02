import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  InstancedBufferAttribute,
  Sprite,
  SpriteNodeMaterial,
} from "three/webgpu";
import {
  atan,
  cameraPosition,
  clamp,
  cross,
  exp,
  float,
  instancedBufferAttribute,
  max,
  mix,
  smoothstep,
  sqrt,
  step,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { hazeTransmittance } from "../haze";
import { pixelAngle } from "../landmarks/common";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import {
  EDGE_LIGHTS,
  END_LIGHTS,
  Light,
  PAPI_LIGHTS,
  RUNWAY,
  TAXIWAY_LIGHTS,
  THRESHOLD_LIGHTS,
} from "./airfield";

/** Lamps sit this far above the ground, metres. */
const LAMP_HEIGHT = 0.4;
/** Glow size, metres, and never smaller than this many pixels. */
const SIZE = 2;
/** Of a sprite's width, what its core covers: where neighbours stack up. */
const CORE = 0.5;
/** Beyond this, metres, lights dim with distance as well. */
const NEAR = 4000;

// The buildings' warm white, so the airport sits in with the city.
const WHITE: Colour = [1, 0.96, 0.9];
const GREEN: Colour = [0.1, 1, 0.35];
const RED: Colour = [1, 0.07, 0.03];

type Colour = [number, number, number];

interface Kind {
  colour: Colour;
  /** Smallest drawn size, pixels: dimmer lights are drawn smaller. */
  pixels: number;
  brightness: number;
  /**
   * The row a light stands in: along the runway or across it (none for
   * taxiways, which wind), metres between lights, and how many there are.
   */
  row: { line?: "along" | "across"; spacing: number; count: number };
  /** How far through lighting-up its circuit's switched on, 0..1. */
  on: number;
}

const KINDS = {
  edge: {
    colour: WHITE,
    pixels: 6,
    brightness: 1.6,
    row: { line: "along", spacing: 60, count: EDGE_LIGHTS.length / 2 },
    on: 0.3,
  },
  threshold: {
    colour: GREEN,
    pixels: 7,
    brightness: 2.2,
    row: { line: "across", spacing: 3, count: THRESHOLD_LIGHTS.length / 2 },
    on: 0.3,
  },
  end: {
    colour: RED,
    pixels: 7,
    brightness: 2.2,
    row: { line: "across", spacing: 6, count: END_LIGHTS.length / 2 },
    on: 0.3,
  },
  // Blue in life; white here, so colour marks only the runway's ends.
  taxiway: {
    colour: WHITE,
    pixels: 5,
    brightness: 1.2,
    row: { spacing: 30, count: 6 },
    on: 0.6,
  },
  papi: {
    colour: RED,
    pixels: 8,
    brightness: 3,
    row: { line: "across", spacing: 9, count: 4 },
    on: 0.45,
  },
} satisfies Record<string, Kind>;

/** World direction a bearing (degrees from grid north) points. */
function facingOf(bearing: number): [number, number] {
  const r = (bearing * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

/**
 * Wellington Airport's runway and taxiway lights, and its PAPIs: four boxes
 * beside each touchdown that show white above their angle and red below, so
 * an approach on the glide path sees two of each. Threshold, end and PAPI
 * lights shine one way only. `lights` (0..1), how far through lighting-up,
 * turns them on a circuit at a time, for night: the runway's (edges, ends
 * and thresholds) first, then the PAPIs, then the taxiways.
 */
export function AirfieldLights({
  index,
  lights = 0,
}: {
  index: TileIndex;
  lights?: number;
}) {
  const on = useMemo(() => uniform(0), []);

  useEffect(() => {
    on.value = lights;
  }, [on, lights]);

  const sprite = useMemo(() => {
    // The runway's axis in the world.
    const [sx, sz] = nztmToWorld(index.manifest, ...RUNWAY.south);
    const [nx, nz] = nztmToWorld(
      index.manifest,
      RUNWAY.south[0] + RUNWAY.axis[0],
      RUNWAY.south[1] + RUNWAY.axis[1]
    );
    const axis = [nx - sx, nz - sz];
    const length = Math.hypot(axis[0], axis[1]);
    const [ax, az] = axis.map((v) => v / length);

    // x, y, z, smallest pixels; r, g, b, switch-on; facing x, z, directed,
    // PAPI angle;
    // row x, z, spacing, count.
    const entries: { a: number[]; b: number[]; c: number[]; d: number[] }[] =
      [];
    const add = (
      [e, n, ground]: Light,
      { colour, pixels, brightness, row, on: switchOn }: Kind,
      facing?: number,
      angle = 0
    ) => {
      const [x, z] = nztmToWorld(index.manifest, e, n);
      const y = ground * verticalScale.value + LAMP_HEIGHT;
      const [fx, fz] = facing === undefined ? [0, 0] : facingOf(facing);
      entries.push({
        a: [x, y, z, pixels],
        b: [...colour.map((v) => v * brightness), switchOn],
        c: [fx, fz, facing === undefined ? 0 : 1, (angle * Math.PI) / 180],
        d: [
          ...{ along: [ax, az], across: [-az, ax], none: [0, 0] }[
            row.line ?? "none"
          ],
          row.spacing,
          row.count,
        ],
      });
    };
    EDGE_LIGHTS.forEach((l) => add(l, KINDS.edge));
    TAXIWAY_LIGHTS.forEach((l) => add(l, KINDS.taxiway));
    THRESHOLD_LIGHTS.forEach(([e, n, g, f]) =>
      add([e, n, g], KINDS.threshold, f)
    );
    END_LIGHTS.forEach(([e, n, g, f]) => add([e, n, g], KINDS.end, f));
    PAPI_LIGHTS.forEach(([e, n, g, f, angle]) =>
      add([e, n, g], KINDS.papi, f, angle)
    );

    const attribute = (key: "a" | "b" | "c" | "d") => {
      const data = new Float32Array(entries.length * 4);
      entries.forEach((entry, i) => data.set(entry[key], i * 4));
      return instancedBufferAttribute<"vec4">(
        new InstancedBufferAttribute(data, 4),
        "vec4"
      );
    };
    const a = attribute("a");
    const b = attribute("b");
    const c = attribute("c");
    const d = attribute("d");
    const position = a.xyz;

    const material = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    material.fog = false;
    material.positionNode = position;
    const toCamera = cameraPosition.sub(position);
    const distance = toCamera.length();
    const scale = max(float(SIZE), distance.mul(pixelAngle).mul(a.w));
    material.scaleNode = scale;

    // Drawn bigger than life, a row's lights pile up on screen, more so seen
    // end on: each gives its share, so the row reads as one light's worth
    // per core's width, not a bar of glare. Taxiway lights stand in no
    // straight row; theirs is taken as square on.
    const row = vec3(d.x, 0, d.y);
    const square = mix(
      float(1),
      cross(toCamera.div(distance), row).length(),
      row.length()
    );
    const share = clamp(
      d.z.mul(square).div(scale.mul(CORE)),
      float(1).div(d.w),
      1
    );
    // Far off, they're points, not lamps.
    const far = clamp(float(NEAR).div(distance), 0, 1);

    // Directed lights fade out as the view swings round behind them.
    const level = vec2(toCamera.x, toCamera.z);
    const toward = level.normalize().dot(c.xy);
    const shown = mix(float(1), smoothstep(-0.2, 0.4, toward), c.z);

    // PAPI boxes: white seen from above their angle, red below, with a thin
    // pink band between.
    const elevation = atan(toCamera.y, level.length());
    const papi = smoothstep(-0.001, 0.001, elevation.sub(c.w));
    const colour = mix(
      b.xyz,
      vec3(...WHITE).mul(KINDS.papi.brightness),
      papi.mul(c.w.sign())
    );

    const r = uv().sub(0.5).length().mul(2);
    // A hot core in a soft halo.
    const glow = exp(r.mul(r).mul(-40)).add(exp(r.mul(-4.5)).mul(0.3));
    const fade = float(1).sub(smoothstep(0.85, 1, r));
    material.colorNode = colour
      .mul(glow.mul(fade).mul(shown).mul(step(b.w, on)).mul(share).mul(far))
      .mul(sqrt(hazeTransmittance(cameraPosition, position)));

    const object = new Sprite(material);
    object.count = entries.length;
    object.frustumCulled = false;
    object.renderOrder = 10;
    return object;
  }, [index, on]);

  // Sprites share one quad geometry; only the material is ours.
  useEffect(() => () => sprite.material.dispose(), [sprite]);

  useFrame(() => {
    sprite.visible = on.value > 0;
  });

  return <primitive object={sprite} />;
}
