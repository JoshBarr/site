import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  DataArrayTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  TextureLoader,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshLambertNodeMaterial,
  MeshStandardNodeMaterial,
  NodeMaterial,
  Texture,
} from "three/webgpu";
import {
  attribute,
  clamp,
  dot,
  float,
  floor,
  int,
  ivec2,
  mix,
  normalize,
  positionGeometry,
  smoothstep,
  textureLoad,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  varying,
  vec4,
} from "three/tsl";
import { TERRAIN_URL, TileIndex, nztmToWorld } from "./manifest";
import { TileCache } from "./TileCache";
import { DrawNode, selectLevel, selectNodes } from "./quadtree";
import { REFLECTION_LAYER, SHADOW_LAYER, shadowCasters } from "../environment";
import {
  DETAIL_SIZE,
  SurfaceMaps,
  createLandcoverBounds,
  shadeSurface,
} from "./surface";
import { createAirfieldMaps, disposeAirfieldMaps } from "../airport/surface";
import { quakeGlow } from "../quakes/glow";

export interface TerrainQuality {
  /** Quads per patch side. */
  gridSize: number;
  /** Texture layers kept resident. */
  slots: number;
  lodFactor: number;
  maxNodes: number;
}

export const TERRAIN_DESKTOP: TerrainQuality = {
  // Near the camera patches split until their vertices meet the data's
  // samples whatever this is; it only sets how fine the distance is. 64 cost
  // twice the vertices (about 8 ms on an M1) for no difference that shows.
  gridSize: 32,
  slots: 256,
  lodFactor: 2.5,
  maxNodes: 800,
};

export const TERRAIN_MOBILE: TerrainQuality = {
  gridSize: 32,
  slots: 96,
  lodFactor: 1.6,
  maxNodes: 400,
};

/**
 * The stand-in drawn into the water's reflection: coarse, cheaply filtered,
 * and blurred and broken up by waves anyway.
 */
const REFLECTION = {
  gridSize: 32,
  lodFactor: 1.5,
  maxNodes: 256,
  maxLevel: 6,
  frustumCulled: false,
  // Draws from whatever the main terrain has loaded; never adds to the cache.
  request: false,
};

/**
 * The stand-in that casts shadows: every tile of one level at full data
 * density, independent of the camera, so the shadow map only re-renders when
 * the sun moves or caster tiles arrive.
 */
const SHADOW_CASTER = {
  // 32m data: hills, not hedgerows. Small enough to keep resident.
  level: 3,
  gridSize: 256,
};

/** Height exaggeration. Scales about sea level, so coastlines don't move. */
export const verticalScale = uniform(1.15);

const COMPONENTS = ["x", "y", "z", "w"] as const;

/** Cubic B-spline weights for samples i-1..i+2, and their derivatives. */
function bspline(f) {
  const f2 = f.mul(f);
  const f3 = f2.mul(f);
  const g = float(1).sub(f);

  const weights = vec4(
    g.mul(g).mul(g),
    f3.mul(3).sub(f2.mul(6)).add(4),
    f3.mul(-3).add(f2.mul(3)).add(f.mul(3)).add(1),
    f3
  ).div(6);

  const derivatives = vec4(
    g.mul(g).negate(),
    f2.mul(3).sub(f.mul(4)),
    f2.mul(-3).add(f.mul(2)).add(1),
    f2
  ).div(2);

  return { weights, derivatives };
}

/**
 * Unit grid in x/z with a skirt hanging off each edge to hide cracks between
 * patches of different detail. Skirt vertices have y = -1.
 */
function createPatchGeometry(n: number) {
  const row = n + 1;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      positions.push(i / n, 0, j / n);
    }
  }

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * row + i;
      indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }

  // Walk the perimeter clockwise from above so skirts face outward.
  const perimeter: number[] = [];

  for (let i = 0; i < n; i++) perimeter.push(i);

  for (let j = 0; j < n; j++) perimeter.push(j * row + n);

  for (let i = n; i > 0; i--) perimeter.push(n * row + i);

  for (let j = n; j > 0; j--) perimeter.push(j * row);
  perimeter.push(0);

  const skirtStart = positions.length / 3;

  for (const top of perimeter) {
    positions.push(positions[top * 3], -1, positions[top * 3 + 2]);
  }

  for (let k = 0; k < perimeter.length - 1; k++) {
    const a = perimeter[k];
    const b = perimeter[k + 1];
    const c = skirtStart + k;
    const d = skirtStart + k + 1;
    indices.push(a, b, c, b, d, c);
  }

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3)
  );
  geometry.setIndex(indices);

  return geometry;
}

/**
 * `smooth` samples with a cubic B-spline (16 reads, smooth slopes); otherwise
 * bilinear (4 reads, faceted), which is plenty for stand-ins.
 *
 * `sink` lowers each patch by that fraction of its vertex spacing. Coarse
 * patches float above valleys next to steep ground; a shadow caster that
 * floats shades everything under it, so casters are sunk instead.
 */
function createMaterial(
  heights: DataArrayTexture,
  index: TileIndex,
  {
    smooth,
    gridSize,
    sink = 0,
    surface,
  }: {
    smooth: boolean;
    gridSize: number;
    sink?: number;
    /** Ground cover; stand-ins without it get flat tones. */
    surface?: SurfaceMaps & { ground: DataArrayTexture };
  }
) {
  const { tileCells, apron } = index.manifest;
  const last = index.samples - 1;

  // originX, originZ, size, slot
  const tileA = attribute("tileA", "vec4");
  // u0, v0, uvScale, level
  const tileB = attribute("tileB", "vec4");

  const slot = int(tileA.w);
  const local = positionGeometry.xz;

  // Continuous sample coordinate in the source tile.
  const texel = tileB.xy.add(local.mul(tileB.z)).mul(tileCells).add(apron);

  const load = (t) =>
    textureLoad(heights, ivec2(clamp(t, vec2(0), vec2(last)))).depth(slot).r;

  /**
   * Height and its gradient (per texel) at a continuous texel coordinate.
   * Cubic B-spline over a 4x4 neighbourhood: smooth and with continuous
   * slopes, so no texel grid shows in the shading or along the coast.
   * Float textures aren't filterable everywhere, so this filters by hand.
   */
  const sample = (t) => {
    const i = floor(t);
    const f = t.sub(i);
    const x = bspline(f.x);
    const z = bspline(f.y);

    let height: any = float(0);
    let gradientX: any = float(0);
    let gradientZ: any = float(0);

    for (let j = 0; j < 4; j++) {
      const at = (k: number) => load(i.add(vec2(k, j - 1)));
      const row = vec4(at(-1), at(0), at(1), at(2));
      const wz = z.weights[COMPONENTS[j]];
      const across = dot(row, x.weights);
      height = height.add(across.mul(wz));
      gradientX = gradientX.add(dot(row, x.derivatives).mul(wz));
      gradientZ = gradientZ.add(across.mul(z.derivatives[COMPONENTS[j]]));
    }

    return { height, gradientX, gradientZ };
  };

  const sampleBilinear = (t) => {
    const i = floor(t);
    const f = t.sub(i);
    const h00 = load(i);
    const h10 = load(i.add(vec2(1, 0)));
    const h01 = load(i.add(vec2(0, 1)));
    const h11 = load(i.add(vec2(1, 1)));

    return {
      height: mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y),
      gradientX: mix(h10.sub(h00), h11.sub(h01), f.y),
      gradientZ: mix(h01.sub(h00), h11.sub(h10), f.x),
    };
  };

  const size = tileA.z;

  const sampled = smooth ? sample(texel) : sampleBilinear(texel);

  // Sampled once per vertex and interpolated: the pixels' shading would
  // otherwise read all of the filter's taps again for each of them.
  const height: any = varying(sampled.height);
  const gradientX: any = varying(sampled.gradientX);
  const gradientZ: any = varying(sampled.gradientZ);

  // Skirts drop a little below the patch to hide cracks.
  const skirt = positionGeometry.y.mul(size).mul(0.05);

  const material: MeshStandardNodeMaterial | MeshLambertNodeMaterial = smooth
    ? new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 })
    : new MeshLambertNodeMaterial();

  material.positionNode = vec3(
    tileA.x.add(local.x.mul(size)),
    height
      .mul(verticalScale)
      .add(skirt)
      .sub(size.mul(sink / gridSize)),
    tileA.y.add(local.y.mul(size))
  );

  // Gradient is per texel; the source tile's samples are this many metres apart.
  const cell = size.div(tileB.z).div(tileCells);
  const slope = vec2(gradientX, gradientZ).mul(verticalScale).div(cell);
  const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));

  // Wet and under water: darker than the beach above it.
  const seabed = mix(
    vec3(0.07),
    vec3(0.02),
    smoothstep(0, 20, height.negate())
  );

  const onLand = smoothstep(-0.5, 0.5, height);

  if (!surface) {
    material.normalNode = transformNormalToView(normal);
    // Flat tones, lighter with altitude.
    const land = mix(vec3(0.16), vec3(0.3), smoothstep(0, 600, height));
    material.colorNode = mix(seabed, land, onLand);

    return material;
  }

  // Relief and buildings, bilinear: smooth enough at the data's spacing.
  const loadGround = (t) =>
    textureLoad(surface.ground, ivec2(clamp(t, vec2(0), vec2(last)))).depth(
      slot
    ).xy;

  const base = floor(texel);
  const f = texel.sub(base);

  const ground = mix(
    mix(loadGround(base), loadGround(base.add(vec2(1, 0))), f.x),
    mix(
      loadGround(base.add(vec2(0, 1))),
      loadGround(base.add(vec2(1, 1))),
      f.x
    ),
    f.y
  );

  const world = vec2(
    tileA.x.add(local.x.mul(size)),
    tileA.y.add(local.y.mul(size))
  );

  const shaded = shadeSurface(surface, {
    world,
    height,
    normal,
    relief: ground.x,
    building: ground.y,
  });

  material.normalNode = transformNormalToView(
    normalize(mix(normal, shaded.normal, onLand))
  );
  material.colorNode = mix(seabed, shaded.color, onLand);
  material.aoNode = mix(float(1), shaded.occlusion, onLand);
  material.emissiveNode = quakeGlow(world);

  return material;
}

/** An instanced mesh of terrain patches, refilled from a selection each frame. */
function createPatches(
  gridSize: number,
  maxNodes: number,
  material: NodeMaterial
) {
  const geometry = createPatchGeometry(gridSize);
  const tileA = new InstancedBufferAttribute(new Float32Array(maxNodes * 4), 4);
  const tileB = new InstancedBufferAttribute(new Float32Array(maxNodes * 4), 4);
  geometry.setAttribute("tileA", tileA);
  geometry.setAttribute("tileB", tileB);
  geometry.instanceCount = 0;

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const nodes: DrawNode[] = [];

  /** Refill from a selection that writes into the given list. */
  const update = (select: (out: DrawNode[]) => void) => {
    select(nodes);
    const a = tileA.array;
    const b = tileB.array;

    nodes.forEach((node, i) => {
      const o = i * 4;
      a[o] = node.originX;
      a[o + 1] = node.originZ;
      a[o + 2] = node.size;
      a[o + 3] = node.slot;
      b[o] = node.u0;
      b[o + 1] = node.v0;
      b[o + 2] = node.uvScale;
      b[o + 3] = node.level;
    });

    geometry.instanceCount = nodes.length;

    if (!nodes.length) return;

    // Upload only the patches in use, not the whole buffer.
    tileA.clearUpdateRanges();
    tileA.addUpdateRange(0, nodes.length * 4);
    tileA.needsUpdate = true;
    tileB.clearUpdateRanges();
    tileB.addUpdateRange(0, nodes.length * 4);
    tileB.needsUpdate = true;
  };

  const dispose = () => {
    geometry.dispose();
    material.dispose();
  };

  return { mesh, update, dispose };
}

/**
 * Land cover, detail and airfield textures. All are created empty and filled
 * in when they arrive, so the material doesn't wait on them.
 */
function useSurfaceMaps(index: TileIndex): SurfaceMaps {
  const maps = useMemo(() => {
    const landcoverBounds = createLandcoverBounds();
    const info = index.manifest.landcover;
    let landcover: Texture;

    if (info) {
      const [west, south, east, north] = info.bounds;
      const [x, z] = nztmToWorld(index.manifest, west, north);
      landcoverBounds.value.set(x, z, east - west, north - south);
      landcover = new TextureLoader().load(`${TERRAIN_URL}/landcover.png`);
    } else {
      // Nothing anywhere: a single black texel.
      landcover = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
      landcover.needsUpdate = true;
    }

    landcover.colorSpace = NoColorSpace;
    landcover.flipY = false;
    landcover.minFilter = LinearMipmapLinearFilter;
    landcover.magFilter = LinearFilter;

    const detail = new DataTexture(
      new Uint8Array(DETAIL_SIZE * DETAIL_SIZE * 4).fill(128),
      DETAIL_SIZE,
      DETAIL_SIZE,
      RGBAFormat
    );

    detail.wrapS = detail.wrapT = RepeatWrapping;
    detail.minFilter = LinearMipmapLinearFilter;
    detail.magFilter = LinearFilter;
    detail.generateMipmaps = true;
    detail.anisotropy = 8;
    detail.needsUpdate = true;

    const airfield = createAirfieldMaps(index.manifest);

    return { landcover, landcoverBounds, detail, airfield };
  }, [index]);

  useEffect(() => {
    const worker = new Worker(new URL("./detailWorker.ts", import.meta.url));
    worker.onmessage = ({ data }) => {
      maps.detail.image.data = data.data;
      maps.detail.needsUpdate = true;
      worker.terminate();
    };

    worker.postMessage({ size: DETAIL_SIZE });

    return () => {
      worker.terminate();
      maps.landcover.dispose();
      maps.detail.dispose();
      disposeAirfieldMaps(maps.airfield);
    };
  }, [maps]);

  return maps;
}

/** Ground height (scaled, metres) at a world x/z, for CPU-side queries. */
export type HeightQuery = (x: number, z: number) => number | undefined;

export function Terrain({
  index,
  quality,
  onHeightQuery,
}: {
  index: TileIndex;
  quality: TerrainQuality;
  onHeightQuery?: (query: HeightQuery | null) => void;
}) {
  const camera = useThree((state) => state.camera);

  const surface = useSurfaceMaps(index);

  const { cache, main, reflection, caster } = useMemo(() => {
    const cache = new TileCache(index, quality.slots);

    const main = createPatches(
      quality.gridSize,
      quality.maxNodes,
      createMaterial(cache.texture, index, {
        smooth: true,
        gridSize: quality.gridSize,
        surface: { ...surface, ground: cache.ground },
      })
    );

    main.mesh.receiveShadow = true;

    const reflection = createPatches(
      REFLECTION.gridSize,
      REFLECTION.maxNodes,
      createMaterial(cache.texture, index, {
        smooth: false,
        gridSize: REFLECTION.gridSize,
      })
    );

    reflection.mesh.layers.set(REFLECTION_LAYER);

    const caster = createPatches(
      SHADOW_CASTER.gridSize,
      index.tilesAt(SHADOW_CASTER.level).length,
      createMaterial(cache.texture, index, {
        smooth: false,
        gridSize: SHADOW_CASTER.gridSize,
        sink: 0.3,
      })
    );

    caster.mesh.layers.set(SHADOW_LAYER);
    caster.mesh.castShadow = true;

    return { cache, main, reflection, caster };
  }, [index, quality, surface]);

  useEffect(() => {
    onHeightQuery?.((x, z) => {
      const height = cache.heightAt(x, z);

      return height === undefined
        ? undefined
        : Math.max(height, 0) * verticalScale.value;
    });

    return () => onHeightQuery?.(null);
  }, [cache, onHeightQuery]);

  useEffect(
    () => () => {
      cache.dispose();
      main.dispose();
      reflection.dispose();
      caster.dispose();
    },
    [cache, main, reflection, caster]
  );

  // What the casters drew last: slot and uvScale per node.
  const casterSignature = useRef<number[]>([]);

  // Options for each selection, with the vertical scale filled in per frame.
  const mainOptions = useMemo(
    () => ({ ...quality, verticalScale: 1 }),
    [quality]
  );

  const reflectionOptions = useMemo(
    () => ({ ...REFLECTION, verticalScale: 1 }),
    []
  );

  useFrame(() => {
    mainOptions.verticalScale = verticalScale.value;
    reflectionOptions.verticalScale = verticalScale.value;
    main.update((out) => selectNodes(index, cache, camera, mainOptions, out));
    reflection.update((out) =>
      selectNodes(index, cache, camera, reflectionOptions, out)
    );
    // Selected every frame so its tiles stay resident; the shadow map only
    // re-renders when what it would draw changes.
    caster.update((out) => {
      selectLevel(index, cache, SHADOW_CASTER.level, out);
      const last = casterSignature.current;

      const same =
        last.length === out.length * 2 &&
        out.every(
          (n, i) => last[i * 2] === n.slot && last[i * 2 + 1] === n.uvScale
        );

      if (!same) {
        casterSignature.current = out.flatMap((n) => [n.slot, n.uvScale]);
        shadowCasters.version++;
      }
    });
    cache.update();
  });

  return (
    <>
      <primitive object={main.mesh} name="terrain" />
      <primitive object={reflection.mesh} />
      <primitive object={caster.mesh} />
    </>
  );
}
