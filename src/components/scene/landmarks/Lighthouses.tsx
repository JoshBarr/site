import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  DoubleSide,
  Mesh,
  MeshStandardNodeMaterial,
  Sprite,
  SpriteNodeMaterial,
} from "three/webgpu";
import {
  atan,
  attribute,
  cameraPosition,
  exp,
  float,
  max,
  mod,
  smoothstep,
  sqrt,
  step,
  time,
  uv,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { hazeTransmittance } from "../haze";
import { obstructionLights, pixelAngle, random } from "./common";
import {
  createLighthouseGeometry,
  lampHeight,
  LightCharacter,
  LighthouseSpec,
} from "./lighthouseGeometry";
import { castsNearShadow } from "./nearShadow";

export interface PlacedLighthouse {
  spec: LighthouseSpec;
  /** World position of the base. */
  position: [number, number, number];
}

/**
 * The glow is never smaller than this many pixels across, nearly all of it
 * faint halo around a point of light; the night's bloom does the rest.
 */
const MIN_PIXELS = 24;
const SIZE = 12;

/** Brightness of the point at the glow's centre, and of its halo. */
const CORE = 3;
const HALO = 0.25;

/** Brightness of the lantern's glass when lit. */
const LANTERN = 2;

/** Seconds a lamp takes to come up or go down. */
const RISE = 0.08;

const COLOURS = {
  white: vec3(1, 0.93, 0.8),
  red: vec3(1, 0.1, 0.04),
};

/** 0..1, how lit `light` is `t` seconds into its period. */
function lit(light: LightCharacter, t: Node<"float">) {
  let on: Node<"float"> = float(0);
  let start = 0;

  light.sequence.forEach((seconds, i) => {
    if (i % 2 === 0) {
      const end = start + seconds;
      on = on.add(
        smoothstep(start, start + RISE, t).mul(
          float(1).sub(smoothstep(end - RISE, end, t))
        )
      );
    }

    start += seconds;
  });

  return on;
}

/** The colour `light` shows toward `bearing`, degrees toward it; black where it doesn't. */
function sectorColour(light: LightCharacter, bearing: Node<"float">) {
  let colour: Node<"vec3"> = vec3(0);

  for (const { from, to, colour: name } of light.sectors) {
    const into = mod(bearing.sub(from), 360);
    const width = (((to - from) % 360) + 360) % 360;
    colour = colour.add(COLOURS[name].mul(step(into, width)));
  }

  return colour;
}

/**
 * What a light shows the camera: the colour of the sector it's seen in, when
 * lit, flashing to its character; black otherwise. The light list's bearings
 * are true, the scene's NZTM grid; the degree or so between them is let go.
 */
function lightShown(light: LightCharacter, lamp: Node<"vec3">, seed: number) {
  const toCamera = cameraPosition.sub(lamp);

  // Bearing from the viewer toward the light: x is east, -z north.
  const bearing = mod(
    atan(toCamera.x.negate(), toCamera.z).mul(180 / Math.PI),
    360
  );

  const period = light.sequence.reduce((sum, seconds) => sum + seconds, 0);
  const t = mod(time.add(random(seed) * period), period);
  // Each has its own photocell, as the obstruction lights do.
  const on = lit(light, t).mul(step(random(seed + 1), obstructionLights));

  return sectorColour(light, bearing).mul(on);
}

/** A point of light with a faint halo, where the lantern is. */
function createLightSprite(
  shown: Node<"vec3">,
  lamp: Node<"vec3">,
  /** Brought this far toward the camera, to clear the lantern's glazing. */
  clearance: number
) {
  const toCamera = cameraPosition.sub(lamp);
  const distance = toCamera.length();

  const material = new SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  material.fog = false;
  material.positionNode = lamp.add(toCamera.div(distance).mul(clearance));
  material.scaleNode = max(
    float(SIZE),
    distance.mul(pixelAngle).mul(MIN_PIXELS)
  );

  const r = uv().sub(0.5).length().mul(2);

  const glow = exp(r.mul(r).mul(-250))
    .mul(CORE)
    .add(exp(r.mul(-5)).mul(HALO));

  const fade = float(1).sub(smoothstep(0.85, 1, r));
  material.colorNode = shown
    .mul(glow.mul(fade))
    .mul(sqrt(hazeTransmittance(cameraPosition, lamp)));

  const sprite = new Sprite(material);
  sprite.frustumCulled = false;
  sprite.renderOrder = 10;

  return sprite;
}

function createLighthouseMaterial(shown?: Node<"vec3">) {
  const material = new MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.7,
    metalness: 0,
    // The gallery rail is an open ring, seen from both sides.
    side: DoubleSide,
  });

  if (shown) {
    material.emissiveNode = shown.mul(
      attribute("glazing", "float").mul(LANTERN)
    );
  }

  return material;
}

/** Lighthouses on the terrain, their lights lit through the night. */
export function Lighthouses({
  lighthouses,
}: {
  lighthouses: PlacedLighthouse[];
}) {
  const objects = useMemo(() => {
    const placed = lighthouses.map(({ spec, position: [x, y, z] }, i) => {
      const lamp = vec3(x, y + lampHeight(spec), z);
      const shown = spec.light && lightShown(spec.light, lamp, i * 2);

      const mesh = new Mesh(
        createLighthouseGeometry(spec),
        createLighthouseMaterial(shown)
      );

      mesh.position.set(x, y, z);
      castsNearShadow(mesh);

      const sprite =
        shown && createLightSprite(shown, lamp, spec.lanternRadius + 0.5);

      return { mesh, sprite };
    });

    return {
      meshes: placed.map(({ mesh }) => mesh),
      sprites: placed.flatMap(({ sprite }) => (sprite ? [sprite] : [])),
    };
  }, [lighthouses]);

  useEffect(
    () => () => {
      objects.meshes.forEach((mesh) => {
        mesh.geometry.dispose();
        mesh.material.dispose();
      });
      // Sprites share one quad geometry; only the materials are ours.
      objects.sprites.forEach((sprite) => sprite.material.dispose());
    },
    [objects]
  );

  useFrame(() => {
    const night = obstructionLights.value > 0;
    objects.sprites.forEach((sprite) => (sprite.visible = night));
  });

  return (
    <>
      {objects.meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} name="lighthouse" />
      ))}
      {objects.sprites.map((sprite) => (
        <primitive key={sprite.uuid} object={sprite} name="lighthouse light" />
      ))}
    </>
  );
}
