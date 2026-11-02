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
  dot,
  exp,
  float,
  linearDepth,
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
  vec3,
  viewportLinearDepth,
} from "three/tsl";
import { TERRAIN_URL, TileIndex } from "../terrain/manifest";
import {
  cloudShadow,
  overcast,
  REFLECTION_LAYER,
  sunDirection,
  sunIntensity,
  sunShadow,
} from "../environment";
import { OceanSimulation } from "./OceanSimulation";
import {
  createCascades,
  DEFAULT_CONDITIONS,
  OceanConditions,
} from "./spectrum";

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
  fftSize: 256,
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
      texture(simulation.displacement[c], world.div(size))
        .level(float(0))
        .xyz.mul(fade)
    );
  });

  const material = new MeshBasicNodeMaterial({ transparent: true });
  material.positionNode = vec3(world.x, 0, world.y).add(
    displacement.mul(shoaling)
  );

  // Fragment: positionGeometry is interpolated, so this is the undisplaced
  // point the vertex sampled from.
  const surface = positionGeometry.xz.add(cameraPosition.xz);
  const depth = depthAt(surface);
  const shallow = smoothstep(0.3, 10, depth);

  let slope: any = vec2(0);
  let jacobian: any = float(1);
  cascades.forEach(({ size }, c) => {
    const uv = surface.div(size);
    const d = texture(simulation.derivatives[c], uv);
    slope = slope.add(vec2(d.x.div(d.z.add(1)), d.y.div(d.w.add(1))));
    if (c < 2) {
      jacobian = jacobian.add(texture(simulation.displacement[c], uv).w.sub(1));
    }
  });
  slope = slope.mul(shallow);

  const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = max(dot(normal, view), 0);
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98));

  const reflected = reflect(view.negate(), normal);

  // The sea sits at y = 0, so a planar mirror is exact for the calm surface;
  // wave slopes then break it up. It renders a cheap terrain stand-in (see
  // REFLECTION_LAYER).
  const mirror = reflector({
    resolutionScale: quality.reflectionScale,
    samples: quality.reflectionSamples,
  });
  mirror.target.rotateX(-Math.PI / 2);
  mirror.uvNode = mirror.uvNode.add(slope.mul(0.12));
  const sky = mirror.rgb;
  const sunAmount = max(dot(reflected, sunDirection), 0);
  // In a hill's or a cloud's shadow the sun's glint and direct light go;
  // skylight stays, so the body of the water only dims and its reflection
  // barely changes.
  const lit = float(sunShadow as any).mul(cloudShadow);
  const glint = pow(sunAmount, 900)
    .mul(40)
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
    .add(overcast.mul(0.3).add(0.25))
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
    .mul(
      mix(0.45, 1, smoothstep(-0.3, 0.6, displacement.y.add(slope.x.mul(2))))
    );
  const foam = max(whitecaps, shoreFoam.mul(0.8));

  // Held back a little: a full-strength mirror reads as glass, not sea.
  const reflection = sky.mul(mix(0.85, 1, lit));
  const color = mix(scatter, reflection, fresnel.mul(0.5)).add(glint);
  material.colorNode = mix(color, vec3(irradiance.mul(0.5)), foam);
  // See the sea floor through the shallows.
  // Slightly clear: the floor shows through the first few metres.
  material.opacityNode = max(float(1).sub(exp(thickness.mul(-0.25))), foam);

  return { material, mirror };
}

function isWebGPU(renderer: WebGPURenderer) {
  return (
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
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
  const renderer = useThree((state) => state.gl) as unknown as WebGPURenderer;
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
      (mesh.material as MeshBasicNodeMaterial).dispose();
    },
    [simulation, mesh]
  );

  useFrame((state) => {
    simulation?.update(renderer, state.clock.elapsedTime);
  });

  return (
    <>
      <primitive object={mesh} />
      <primitive object={mirror.target} />
    </>
  );
}
