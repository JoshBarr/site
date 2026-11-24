import { useEffect, useMemo } from "react";
import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  ShapeUtils,
  Sprite,
  SpriteNodeMaterial,
  Vector2,
} from "three/webgpu";
import {
  cameraPosition,
  exp,
  float,
  instancedBufferAttribute,
  max,
  positionWorld,
  smoothstep,
  sqrt,
  uniform,
  uv,
  vec3,
} from "three/tsl";
import { windowLights } from "../buildings/material";
import { hazeTransmittance } from "../haze";
import { pixelAngle } from "../landmarks/common";
import { verticalScale } from "../terrain/Terrain";
import { nztmToWorld, type TileIndex } from "../terrain/manifest";
import { VENUE_SITES } from "./venues";

// The stadium on a game night: the pitch bright under its floodlights, and
// the lights themselves, a ring of banks along the roof's inner edge. Where
// the banks are and how bright it all is are guesses from photos.

/** 0..1: how far the floodlights are on (the Events layer sets it). */
export const stadiumLit = uniform(0);

/** The pitch under them, as the eye sees it at night: far the brightest grass. */
const PITCH = 0.35;

/** LED floodlights: a cold white. */
const COLD = vec3(0.92, 0.96, 1);

/** The pitch is drawn this far over the ground, m, clear of it. */
const PITCH_LIFT = 0.5;

/** Banks of lights around the roof's edge. */
const BANKS = 36;

/** The roof's inner edge, as a share of the way out from the centre. */
const ROOF_EDGE = 0.72;

/** And how far below the roof's top they hang, m. */
const BANK_DROP = 3;

/** Each bank's glare is never smaller than this many pixels across. */
const MIN_PIXELS = 9;
const SIZE = 5;

/** Brightness of a bank's glare at its centre. */
const GLARE = 2.5;

/** Evenly spaced points `count` around the closed ring `ring`. */
function around(ring: number[][], count: number) {
  const lengths = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];

    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  });

  const total = lengths.reduce((a, b) => a + b, 0);
  const points: number[][] = [];
  let edge = 0;
  let walked = 0;

  for (let k = 0; k < count; k++) {
    const at = (k / count) * total;

    while (walked + lengths[edge] < at) walked += lengths[edge++];

    const t = (at - walked) / (lengths[edge] || 1);
    const a = ring[edge];
    const b = ring[(edge + 1) % ring.length];
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }

  return points;
}

/** The stadium's pitch and floodlight banks, lit as stadiumLit says. */
export function Stadium({ index }: { index: TileIndex }) {
  const { manifest } = index;

  const objects = useMemo(() => {
    const { centre, ground, height, ring, pitch } = VENUE_SITES.stadium;

    if (!ring || !pitch) return null;

    const world = ([e, n]: number[]) => nztmToWorld(manifest, e, n);
    const base = ground * verticalScale.value;

    // The pitch: its outline filled, flat, just over the ground.
    const outline = pitch.map(world);

    const triangles = ShapeUtils.triangulateShape(
      outline.map(([x, z]) => new Vector2(x, z)),
      []
    );

    const geometry = new BufferGeometry();

    geometry.setAttribute(
      "position",
      new Float32BufferAttribute(
        outline.flatMap(([x, z]) => [x, base + PITCH_LIFT, z]),
        3
      )
    );
    geometry.setIndex(triangles.flat());

    const lit = stadiumLit.mul(windowLights);
    const seen = hazeTransmittance(cameraPosition, positionWorld);

    // The outline's winding flips going to world z (south): either face.
    const pitchMaterial = new MeshBasicNodeMaterial({
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    pitchMaterial.fog = false;
    pitchMaterial.colorNode = COLD.mul(lit.mul(PITCH)).mul(seen);

    const field = new Mesh(geometry, pitchMaterial);
    field.renderOrder = 5;

    // The banks: round the stands, drawn in toward the middle to the roof's
    // inner edge.
    const [cx, cz] = world(centre);
    const top = base + height - BANK_DROP;

    const banks = around(ring.map(world), BANKS).flatMap(([x, z]) => [
      cx + (x - cx) * ROOF_EDGE,
      top,
      cz + (z - cz) * ROOF_EDGE,
    ]);

    const position = instancedBufferAttribute<"vec3">(
      new InstancedBufferAttribute(new Float32Array(banks), 3),
      "vec3"
    );

    const glareMaterial = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    glareMaterial.fog = false;
    glareMaterial.positionNode = position;
    glareMaterial.scaleNode = max(
      float(SIZE),
      cameraPosition.distance(position).mul(pixelAngle).mul(MIN_PIXELS)
    );

    const r = uv().sub(0.5).length().mul(2);
    const glow = exp(r.mul(r).mul(-30)).add(exp(r.mul(-5)).mul(0.3));

    glareMaterial.colorNode = COLD.mul(
      glow.mul(float(1).sub(smoothstep(0.85, 1, r))).mul(lit.mul(GLARE))
    ).mul(sqrt(hazeTransmittance(cameraPosition, position)));

    const glare = new Sprite(glareMaterial);
    glare.count = BANKS;
    glare.frustumCulled = false;
    glare.renderOrder = 10;

    return { field, glare };
  }, [manifest]);

  useEffect(
    () => () => {
      if (!objects) return;
      objects.field.geometry.dispose();
      objects.field.material.dispose();
      objects.glare.material.dispose();
    },
    [objects]
  );

  if (!objects) return null;

  return (
    <>
      <primitive object={objects.field} name="stadium pitch" />
      <primitive object={objects.glare} name="stadium floodlights" />
    </>
  );
}
