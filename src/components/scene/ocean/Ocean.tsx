import { useEffect, useMemo } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NoColorSpace,
  Texture,
  TextureLoader,
  WebGPURenderer,
} from "three/webgpu";
import {
  cameraFar,
  cameraNear,
  cameraPosition,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  linearDepth,
  log2,
  max,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  reflector,
  smoothstep,
  texture,
  vec2,
  varying,
  vec3,
  viewportLinearDepth,
} from "three/tsl";
import { TERRAIN_URL, TileIndex } from "../terrain/manifest";
import {
  cloudShadow,
  nearShadow,
  REFLECTION_LAYER,
  seaLevel,
  skylight,
  sunDirection,
  sunIntensity,
  sunShadow,
} from "../environment";
import { OceanSimulation } from "./OceanSimulation";
import { quakeGlow } from "../quakes/glow";
import {
  createCascades,
  DEFAULT_CONDITIONS,
  OceanConditions,
} from "./spectrum";
import { useRenderer } from "../renderer";
import { switchedOff } from "../stats";

export interface OceanQuality {
  /** FFT resolution per cascade. */
  fftSize: number;
  /** Vertices around each ring of the surface mesh. */
  segments: number;
  /** Reflection render size relative to the canvas. */
  reflectionScale: number;
  /** MSAA samples for the reflection. Distortion mostly hides its edges. */
  reflectionSamples: number;
}

export const OCEAN_DESKTOP: OceanQuality = {
  // 256 cost about 4 ms more on an M1: each FFT stage streams every buffer
  // through memory. The mesh can't carry finer waves than 128 gives anyway.
  fftSize: 128,
  segments: 384,
  reflectionScale: 0.35,
  reflectionSamples: 0,
};

export const OCEAN_MOBILE: OceanQuality = {
  fftSize: 128,
  segments: 192,
  reflectionScale: 0.25,
  reflectionSamples: 0,
};

const CASCADE_SIZES = [503, 89, 13];
const RADIUS = 45000;

/** How tight the sun's glint is off smooth water: the exponent of its lobe. */
const GLINT = 900;

/**
 * Disc of rings around the origin. Ring spacing grows with radius so cells
 * stay roughly square, which keeps vertex density matched to screen size.
 */
function createSurfaceGeometry(segments: number) {
  const radii = [0];
  const minStep = 1.5;

  while (radii[radii.length - 1] < RADIUS) {
    const r = radii[radii.length - 1];
    radii.push(r + Math.max(minStep, (r * 2 * Math.PI) / segments));
  }

  const positions = [0, 0, 0];

  for (let ring = 1; ring < radii.length; ring++) {
    for (let s = 0; s < segments; s++) {
      const angle = (s / segments) * Math.PI * 2;
      positions.push(
        Math.cos(angle) * radii[ring],
        0,
        Math.sin(angle) * radii[ring]
      );
    }
  }

  const indices: number[] = [];

  const vertex = (ring: number, s: number) =>
    1 + (ring - 1) * segments + (s % segments);

  for (let s = 0; s < segments; s++) {
    indices.push(0, vertex(1, s + 1), vertex(1, s));
  }

  for (let ring = 1; ring < radii.length - 1; ring++) {
    for (let s = 0; s < segments; s++) {
      const a = vertex(ring, s);
      const b = vertex(ring, s + 1);
      const c = vertex(ring + 1, s);
      const d = vertex(ring + 1, s + 1);
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3)
  );
  geometry.setIndex(indices);

  return geometry;
}

/** Without a simulation the sea is flat but shaded the same way. */
function createMaterial(
  simulation: OceanSimulation | null,
  water: Texture,
  index: TileIndex,
  quality: OceanQuality
) {
  const cascades = simulation?.cascades ?? [];
  const displacements = simulation?.displacement ?? [];
  const derivatives = simulation?.derivatives ?? [];
  const fftSize = simulation?.size ?? 1;
  const { rootSize } = index.manifest;
  const maxDepth = index.manifest.water?.maxDepth ?? 30;
  const sqrtEncoded = index.manifest.water?.encoding === "sqrt";

  // The mesh follows the camera; waves are sampled in world space.
  const world = positionGeometry.xz.add(cameraPosition.xz);
  const distance = positionGeometry.xz.length();

  const depthAt = (xz) => {
    const v = texture(water, xz.div(rootSize).add(0.5)).r;

    return (sqrtEncoded ? v.mul(v) : v).mul(maxDepth);
  };

  // Waves shoal and die in shallow water.
  const shoaling = smoothstep(0.3, 10, depthAt(world));

  let displacement: any = vec3(0);
  cascades.forEach(({ size }, c) => {
    // Vertex density falls with distance, so drop each cascade once its
    // waves are smaller than the mesh can carry.
    const fade = float(1).sub(smoothstep(size * 4, size * 16, distance));
    displacement = displacement.add(
      texture(displacements[c], world.div(size)).level(float(0)).xyz.mul(fade)
    );
  });

  // The vertex's rise, for the shore foam. Passed down: used as is in the
  // fragment stage, each pixel would sample the three cascades again.
  const heave: any = varying(displacement.y);

  const material = new MeshBasicNodeMaterial({ transparent: true });
  material.positionNode = vec3(world.x, seaLevel, world.y).add(
    displacement.mul(shoaling)
  );

  // Fragment: positionGeometry is interpolated, so this is the undisplaced
  // point the vertex sampled from.
  const surface = positionGeometry.xz.add(cameraPosition.xz);
  const depth = depthAt(surface);
  const shallow = smoothstep(0.3, 10, depth);

  // Metres of sea a pixel spans, the long way.
  const footprint = max(dFdx(surface).length(), dFdy(surface).length());

  let slope: any = vec2(0);
  let jacobian: any = float(1);
  // Slope too fine to draw: what the mips have averaged out of the normal.
  let unseen: any = float(0);
  cascades.forEach(({ size }, c) => {
    // (slope x, slope z, jacobian, slope squared)
    const d = texture(derivatives[c], surface.div(size));
    slope = slope.add(d.xy);

    // The finest cascade's ripples are under a pixel from any height, and
    // the glint's never counted them: the look is of the two that draw.
    if (c >= 2) return;

    jacobian = jacobian.add(d.z.sub(1));

    // The squares' mean less the mean's square. Only where the map's
    // minified: between two texels the same sum is the slope's change
    // across them, which is drawn.
    const minified = log2(footprint.div(size / fftSize)).saturate();
    unseen = unseen.add(max(d.w.sub(d.xy.dot(d.xy)), 0).mul(minified));
  });
  slope = slope.mul(shallow);
  unseen = unseen.mul(shallow).mul(shallow);

  const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = max(dot(normal, view), 0);
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98));

  const reflected = reflect(view.negate(), normal);

  // The sea sits level at the tide's height, which the mirror follows, so a
  // planar mirror is exact for the calm surface; wave slopes then break it
  // up. It renders a cheap terrain stand-in (see REFLECTION_LAYER).
  const mirror = reflector({
    resolutionScale: quality.reflectionScale,
    samples: quality.reflectionSamples,
  });

  mirror.target.rotateX(-Math.PI / 2);

  if (mirror.uvNode) mirror.uvNode = mirror.uvNode.add(slope.mul(0.12));
  // Left out of the material, the mirror isn't rendered.
  const sky = switchedOff("reflection") ? vec3(0.04) : mirror.rgb;
  const sunAmount = max(dot(reflected, sunDirection), 0);

  // In a hill's, a ship's or a cloud's shadow the sun's glint and direct light
  // go; skylight stays, so the body of the water only dims and its reflection
  // barely changes.
  // SAFETY: shadow() makes a float node; see environment.ts.
  const lit = float(sunShadow as any)
    .mul(nearShadow as any)
    .mul(cloudShadow);

  // The sun's glint off each facet that mirrors it.
  const sparkle = pow(sunAmount, GLINT).mul(40);

  // Far off, the waves that carry those glints are smaller than a pixel and
  // averaged out of the normal, so the glint stopped a couple of kilometres
  // out and the far sea was a mirror. There the glints' average stands in:
  // how likely a wave is to have the slope that mirrors the sun to the eye,
  // taking the slopes the mips averaged away as Gaussian about the one
  // drawn. Its peak spreads the sparkle's own light over that range of
  // slopes: a lobe cos^n about the mirror direction is one of slope variance
  // 1/4n each way, since a reflection turns twice as far as its surface.
  // Worked in slopes, it comes out as the long narrow path a low sun lays
  // on the water, not a round patch.
  const half = normalize(view.add(sunDirection));
  const mirroring = half.xz.div(max(half.y, 0.05)).negate();
  const miss = mirroring.sub(slope);
  const spread = max(unseen.mul(0.5), 1e-5);

  const path = exp(miss.dot(miss).div(spread.mul(-2)))
    .div(spread)
    .mul(40 / (4 * GLINT));

  // All sparkle where every wave's drawn, all path where none is.
  const averaged = unseen.div(unseen.add(1 / GLINT));

  const glint = mix(sparkle, path, averaged)
    .add(pow(sunAmount, 60).mul(0.25))
    .mul(sunIntensity)
    .mul(lit);

  // Lit like the land: sun on a level surface plus the sky (the scene's
  // ambient light), over π as for a Lambertian albedo. Keeps the water darker
  // than the shore whatever the light.
  const irradiance = sunIntensity
    .mul(3)
    .mul(max(sunDirection.y, 0))
    .mul(lit)
    .add(skylight)
    .div(Math.PI);

  // Light that enters and scatters back out: brighter on crests facing the sun.
  // Deep water swallows the light and goes darker. Two falloffs, so the chart's
  // bands read: pale shelves over the first five metres or so, the harbour
  // basin and dredged berths (10-20m) a mid tone, Cook Strait (100m+) black.
  // Reflectances, well under the land's (sand 0.26, grass 0.15).
  const reflectance = float(0.001)
    .add(exp(depth.div(-40)).mul(0.014))
    .add(exp(depth.div(-4.5)).mul(0.07));

  const scatter = vec3(reflectance.mul(irradiance)).add(
    max(dot(normal, sunDirection), 0).mul(0.02).mul(sunIntensity).mul(lit)
  );

  // Whitecaps where the surface folds over (jacobian drops below 1).
  const whitecaps = smoothstep(0.85, 0.35, jacobian).mul(shallow);

  // Water thickness along the view ray, from the scene depth behind it.
  const thickness = viewportLinearDepth
    .sub(linearDepth())
    .mul(cameraFar.sub(cameraNear));

  // A continuous band that swells and recedes with the waves.
  const shoreFoam = float(1)
    .sub(smoothstep(0, 1.2, thickness))
    .mul(mix(0.45, 1, smoothstep(-0.3, 0.6, heave.add(slope.x.mul(2)))));

  const foam = max(whitecaps, shoreFoam.mul(0.8));

  // Held back a little: a full-strength mirror reads as glass, not sea.
  const reflection = sky.mul(mix(0.85, 1, lit));
  const color = mix(scatter, reflection, fresnel.mul(0.5)).add(glint);
  material.colorNode = mix(color, vec3(irradiance.mul(0.5)), foam).add(
    quakeGlow(surface)
  );
  // See the sea floor through the shallows.
  // Slightly clear: the floor shows through the first few metres.
  material.opacityNode = max(float(1).sub(exp(thickness.mul(-0.25))), foam);

  return { material, mirror };
}

function isWebGPU(renderer: WebGPURenderer) {
  return (
    "isWebGPUBackend" in renderer.backend &&
    renderer.backend.isWebGPUBackend === true
  );
}

export function Ocean({
  index,
  quality,
  conditions = DEFAULT_CONDITIONS,
}: {
  index: TileIndex;
  quality: OceanQuality;
  conditions?: OceanConditions;
}) {
  const renderer = useRenderer();
  const camera = useThree((state) => state.camera);
  const supported = isWebGPU(renderer);
  const water = useLoader(TextureLoader, `${TERRAIN_URL}/water.png`);

  const { simulation, mesh, mirror } = useMemo(() => {
    water.colorSpace = NoColorSpace;
    // Row 0 is the northern edge, matching world -z.
    water.flipY = false;
    water.minFilter = water.magFilter = LinearFilter;
    water.generateMipmaps = false;

    // The simulation needs compute shaders writing storage textures, which
    // the WebGL 2 fallback can't do.
    const simulation = supported
      ? new OceanSimulation(quality.fftSize, createCascades(CASCADE_SIZES))
      : null;

    const { material, mirror } = createMaterial(
      simulation,
      water,
      index,
      quality
    );

    const mesh = new Mesh(createSurfaceGeometry(quality.segments), material);
    mirror.reflector.getVirtualCamera(camera).layers.set(REFLECTION_LAYER);
    mesh.frustumCulled = false;
    // After the terrain, so the depth behind the water is known.
    mesh.renderOrder = 1;

    return { simulation, mesh, mirror };
  }, [index, quality, water, supported, camera]);

  useEffect(() => {
    simulation?.setConditions(conditions);
  }, [simulation, conditions]);

  useEffect(
    () => () => {
      simulation?.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
    [simulation, mesh]
  );

  useFrame((state) => {
    simulation?.update(renderer, state.clock.elapsedTime);
    mirror.target.position.y = seaLevel.value;
  });

  return (
    <>
      <primitive object={mesh} name="ocean" />
      <primitive object={mirror.target} />
    </>
  );
}
