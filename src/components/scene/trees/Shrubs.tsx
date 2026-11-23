import { useEffect, useMemo, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  Box3,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Material,
  Matrix4,
  Mesh,
  Vector3,
  Vector4,
} from "three/webgpu";
import { castsNearShadow, nearShadowFrustum } from "../landmarks/nearShadow";
import { TERRAIN_URL, type TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import type { TileCache } from "../terrain/TileCache";
import { SHRUB_RANGES, shrubAttributes } from "./geometry";
import { TREES_URL } from "./manifest";
import {
  createShrubMaterial,
  shrubFullDistance,
  shrubMaxDistance,
  shrubShare,
  SIZE_SPLIT,
} from "./shrubMaterial";

export interface ShrubsQuality {
  /** Every shrub is drawn this close, m; further out, fewer. */
  fullDistance: number;
  /** None beyond, m. */
  maxDistance: number;
  /** Cast into the near shadow map, this close, m; 0 for none. */
  shadowDistance: number;
  /** Chunks built a frame, at most, and milliseconds spent on them. */
  budget: { chunks: number; ms: number };
}

export const SHRUBS_DESKTOP: ShrubsQuality = {
  fullDistance: 250,
  maxDistance: 900,
  shadowDistance: 400,
  budget: { chunks: 6, ms: 3 },
};

export const SHRUBS_MOBILE: ShrubsQuality = {
  fullDistance: 100,
  maxDistance: 350,
  shadowDistance: 0,
  budget: { chunks: 3, ms: 2 },
};

/** Shrubs are scattered in squares this wide, m. */
const CHUNK = 64;

/** Candidates per chunk side: one in each cell of a jittered grid. */
const CELLS = 21;
const SPACING = CHUNK / CELLS;

/** A candidate's chance of a shrub, per share of scrub cover. */
const DENSITY = 1.4;

/** Town's scrub is partly parked cars and fences: thinned by its share. */
const URBAN_THINNING = 0.65;

/** Shrubs keep this clear of the kerb, m, and off any building. */
const KERB_CLEARANCE = 1.2;
const MAX_BUILDING = 0.02;

/** Tiles further than this draw their shrubs' lobes as octahedra, m. */
const DISTANT = 220;

/** Chunks this far past the far limit are let go. */
const KEEP = 1.3;

/** Chunks checked a frame for finer terrain having arrived under them. */
const RECHECK = 24;

/** Must match ROAD_ZERO and ROAD_UNIT in build_tiles.py. */
const ROAD_ZERO = 128;
const ROAD_UNIT = 8;

/** Scrub and town cover over the terrain's land cover grid. */
interface Cover {
  scrub: Uint8Array;
  urban: Uint8Array;
  /** World x/z of the grid's north-west corner, and metres a texel. */
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
}

async function loadChannel(url: string, channel: number) {
  const response = await fetch(url);

  if (!response.ok) throw new Error(`${url}: ${response.status}`);

  // Fractions, not colours: they must arrive untouched.
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });

  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const values = new Uint8Array(width * height);

  for (let i = 0; i < values.length; i++) values[i] = rgba[i * 4 + channel];

  return { values, width, height };
}

async function loadCover(terrain: TileIndex): Promise<Cover> {
  const { landcover, origin } = terrain.manifest;

  if (!landcover) throw new Error("terrain manifest has no land cover");

  const [scrub, urban] = await Promise.all([
    loadChannel(`${TREES_URL}/scrub.png`, 0),
    loadChannel(`${TERRAIN_URL}/landcover.png`, 2),
  ]);

  const [west, , east, north] = landcover.bounds;

  if (scrub.width !== urban.width || scrub.height !== urban.height) {
    throw new Error("scrub was built for a different land cover grid");
  }

  return {
    scrub: scrub.values,
    urban: urban.values,
    x0: west - origin[0],
    z0: -(north - origin[1]),
    cell: (east - west) / scrub.width,
    cols: scrub.width,
    rows: scrub.height,
  };
}

/** Bilinear share (0..1) of a cover channel at world x/z. */
function coverAt(cover: Cover, values: Uint8Array, x: number, z: number) {
  const u = (x - cover.x0) / cover.cell - 0.5;
  const v = (z - cover.z0) / cover.cell - 0.5;

  if (u < 0 || v < 0 || u >= cover.cols - 1 || v >= cover.rows - 1) return 0;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const s = j * cover.cols + i;
  const top = values[s] * (1 - fu) + values[s + 1] * fu;

  const bottom =
    values[s + cover.cols] * (1 - fu) + values[s + cover.cols + 1] * fu;

  return (top * (1 - fv) + bottom * fv) / 255;
}

/** 0..1 from integer coordinates and a salt. */
function hash2(x: number, y: number, salt: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h ^= Math.imul(salt, 144665);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);

  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Chunk {
  key: string;
  cx: number;
  cz: number;
  /** Terrain level its ground came from. */
  level: number;
  count: number;
  minY: number;
  maxY: number;
  mesh?: Mesh<InstancedBufferGeometry>;
}

const surface = { building: 0, kerb: 0 };

/**
 * Scatter one chunk's shrubs: a candidate in each cell, kept by the scrub
 * cover there, off streets, buildings and the sea; in a random order, so a
 * prefix is an even thinning.
 */
function scatter(cover: Cover, cache: TileCache, cx: number, cz: number) {
  const scale = verticalScale.value;
  const found: { key: number; values: number[] }[] = [];
  let minY = Infinity;
  let maxY = -Infinity;

  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const gx = cx * CELLS + i;
      const gz = cz * CELLS + j;
      const x = (gx + hash2(gx, gz, 1)) * SPACING;
      const z = (gz + hash2(gx, gz, 2)) * SPACING;
      const scrub = coverAt(cover, cover.scrub, x, z);

      if (scrub <= 0) continue;
      const urban = coverAt(cover, cover.urban, x, z);
      const chance = scrub * DENSITY * (1 - URBAN_THINNING * urban);

      if (hash2(gx, gz, 3) >= chance) continue;
      const ground = cache.heightAt(x, z);

      if (ground === undefined || ground < 0.5) continue;
      const radius = (0.7 + hash2(gx, gz, 4) * 1.1) * (0.75 + 0.5 * scrub);

      if (cache.surfaceAt(x, z, surface)) {
        const kerb = (surface.kerb * 255 - ROAD_ZERO) / ROAD_UNIT;

        if (kerb < KERB_CLEARANCE + radius * 0.6) continue;

        if (surface.building > MAX_BUILDING) continue;
      }

      const height = Math.min(radius * (0.8 + hash2(gx, gz, 5) * 0.7), 2.9);
      const y = ground * scale;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + height);

      found.push({
        key: hash2(gx, gz, 6),
        values: [
          x,
          y,
          z,
          Math.round(radius * 100) * SIZE_SPLIT + Math.round(height * 100),
        ],
      });
    }
  }

  found.sort((a, b) => a.key - b.key);
  const data = new Float32Array(found.length * 4);
  found.forEach(({ values }, n) => data.set(values, n * 4));

  return { data, minY, maxY };
}

const box = new Box3();
const frustum = new Frustum();
const shadowFrustum = new Frustum();
const projScreen = new Matrix4();
const cameraPosition = new Vector3();

function setBox(chunk: { cx: number; cz: number; minY: number; maxY: number }) {
  box.min.set(chunk.cx * CHUNK - 2, chunk.minY - 2, chunk.cz * CHUNK - 2);
  box.max.set(
    (chunk.cx + 1) * CHUNK + 2,
    chunk.maxY + 4,
    (chunk.cz + 1) * CHUNK + 2
  );

  return box;
}

/**
 * Shrubs where the lidar found scrub too low for trees (see `scrub` in
 * build_trees.py), scattered in chunks around the camera by its cover and
 * grounded on the terrain as loaded. Chunks are rebuilt as finer terrain
 * arrives under them.
 */
export function Shrubs({
  terrain,
  cache,
  quality,
}: {
  terrain: TileIndex;
  cache: TileCache;
  quality: ShrubsQuality;
}) {
  const [cover, setCover] = useState<Cover | null>(null);

  useEffect(() => {
    let live = true;
    loadCover(terrain).then(
      (cover) => live && setCover(cover),
      (e) => console.error(`shrubs: ${e}`)
    );

    return () => {
      live = false;
    };
  }, [terrain]);

  return cover && <ShrubChunks cover={cover} cache={cache} quality={quality} />;
}

function ShrubChunks({
  cover,
  cache,
  quality,
}: {
  cover: Cover;
  cache: TileCache;
  quality: ShrubsQuality;
}) {
  const camera = useThree((state) => state.camera);

  const { group, material, chunks } = useMemo(() => {
    const group = new Group();
    group.matrixAutoUpdate = false;

    return {
      group,
      material: createShrubMaterial(),
      chunks: new Map<string, Chunk>(),
    };
  }, []);

  useEffect(() => {
    shrubFullDistance.value = quality.fullDistance;
    shrubMaxDistance.value = quality.maxDistance;
  }, [quality]);

  useEffect(
    () => () => {
      for (const chunk of chunks.values()) chunk.mesh?.geometry.dispose();
      chunks.clear();
      group.clear();
      material.dispose();
    },
    [chunks, group, material]
  );

  const recheck = useMemo(() => ({ next: 0 }), []);

  useFrame(() => {
    camera.getWorldPosition(cameraPosition);
    projScreen.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    frustum.setFromProjectionMatrix(projScreen, camera.coordinateSystem);
    const shadows = quality.shadowDistance > 0;

    if (shadows) nearShadowFrustum(shadowFrustum);

    const reach = quality.maxDistance;

    const ground =
      (cache.heightAt(cameraPosition.x, cameraPosition.z) ?? 0) *
      verticalScale.value;

    const above = Math.max(cameraPosition.y - ground, 0);

    for (const chunk of chunks.values()) {
      if (chunk.mesh) chunk.mesh.visible = false;
    }

    if (above >= reach) return;
    const flat = Math.sqrt(reach * reach - above * above);
    const c0 = Math.floor((cameraPosition.x - flat) / CHUNK);
    const c1 = Math.floor((cameraPosition.x + flat) / CHUNK);
    const r0 = Math.floor((cameraPosition.z - flat) / CHUNK);
    const r1 = Math.floor((cameraPosition.z + flat) / CHUNK);
    const wanted: { cx: number; cz: number; distance: number }[] = [];

    for (let cz = r0; cz <= r1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const key = `${cx}/${cz}`;
        const chunk = chunks.get(key);

        const distance = setBox(
          chunk ?? { cx, cz, minY: ground - 50, maxY: ground + 50 }
        ).distanceToPoint(cameraPosition);

        const share = shrubShare(distance);

        if (!share || !frustum.intersectsBox(box)) continue;

        if (!chunk) {
          wanted.push({ cx, cz, distance });
          continue;
        }

        const mesh = chunk.mesh;

        if (!mesh) continue;
        mesh.visible = true;
        mesh.geometry.instanceCount = Math.ceil(chunk.count * share);
        const range = SHRUB_RANGES[distance > DISTANT ? 1 : 0];
        mesh.geometry.setDrawRange(range.start, range.count);

        if (shadows) {
          mesh.castShadow =
            distance < quality.shadowDistance &&
            shadowFrustum.intersectsBox(box);
        }
      }
    }

    // New chunks, nearest first, then chunks whose terrain has sharpened.
    wanted.sort((a, b) => a.distance - b.distance);
    const start = performance.now();
    let built = 0;

    const spent = () =>
      built >= quality.budget.chunks ||
      performance.now() - start > quality.budget.ms;

    for (const { cx, cz } of wanted) {
      if (spent()) break;
      build(cx, cz);
      built++;
    }

    const all = [...chunks.values()];

    for (let n = 0; n < Math.min(RECHECK, all.length) && !spent(); n++) {
      const chunk = all[(recheck.next + n) % all.length];
      const x = (chunk.cx + 0.5) * CHUNK;
      const z = (chunk.cz + 0.5) * CHUNK;

      if (cache.levelAt(x, z) > chunk.level) {
        build(chunk.cx, chunk.cz);
        built++;
      }
    }

    recheck.next += RECHECK;

    // Let go of chunks well out of reach.
    for (const [key, chunk] of chunks) {
      const distance = setBox(chunk).distanceToPoint(cameraPosition);

      if (distance > reach * KEEP) {
        if (chunk.mesh) {
          group.remove(chunk.mesh);
          chunk.mesh.geometry.dispose();
        }

        chunks.delete(key);
      }
    }
  });

  function build(cx: number, cz: number) {
    const key = `${cx}/${cz}`;
    const x = (cx + 0.5) * CHUNK;
    const z = (cz + 0.5) * CHUNK;
    const level = cache.levelAt(x, z);
    const { data, minY, maxY } = scatter(cover, cache, cx, cz);
    const old = chunks.get(key);

    if (old?.mesh) {
      group.remove(old.mesh);
      old.mesh.geometry.dispose();
    }

    const count = data.length / 4;

    const mesh = count
      ? createChunkMesh(data, count, material, quality.shadowDistance > 0)
      : undefined;

    if (mesh) group.add(mesh);
    // An empty chunk is boxed at its middle's ground, to be let go in time.
    const middle = (cache.heightAt(x, z) ?? 0) * verticalScale.value;
    chunks.set(key, {
      key,
      cx,
      cz,
      level,
      count,
      minY: count ? minY : middle,
      maxY: count ? maxY : middle,
      mesh,
    });
  }

  return <primitive object={group} name="shrubs" />;
}

function createChunkMesh(
  data: Float32Array,
  count: number,
  material: Material,
  shadows: boolean
) {
  const geometry = new InstancedBufferGeometry();
  const { lobe, index } = shrubAttributes();
  geometry.setAttribute("lobe", lobe);
  geometry.setIndex(index);
  geometry.setAttribute("shrub", new InstancedBufferAttribute(data, 4));
  geometry.instanceCount = 0;

  const mesh = new Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.userData.chunk = new Vector4(count, 0, 0, 0);
  // Culled per chunk above; there's no position attribute to bound.
  mesh.frustumCulled = false;
  mesh.visible = false;

  if (shadows) castsNearShadow(mesh);
  else mesh.receiveShadow = true;

  return mesh;
}
