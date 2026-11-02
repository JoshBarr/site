import { MeshLambertNodeMaterial, Vector2, Vector3, Vector4 } from "three/webgpu";
import {
  attribute,
  clamp,
  cos,
  cross,
  dFdx,
  dFdy,
  float,
  floor,
  hash,
  instanceIndex,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  pow,
  select,
  sign,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  uniform,
  varying,
  vec2,
  vec3,
  vertexIndex,
} from "three/tsl";
import { verticalScale } from "../terrain/Terrain";
import type { TreesManifest } from "./manifest";

// Trees in the scene's greys: dark crowns, darker underneath and between
// trees, faceted a little like the buildings. Each is placed and sized from
// the lidar (see build_trees.py) and shaped from its proportions: tall,
// narrow crowns taper like conifers, wide ones are rounded.

/** Foliage albedo, from dark pines to paler broadleaf. */
const FOLIAGE = [0.035, 0.085];
const BARK = 0.05;
/** Share of each crown's top-to-bottom shade from facets rather than its shape. */
const FACETS = 0.45;
/** Radius jitter per vertex, ±. */
const LUMPS = 0.18;
/** Trunks start this far underground, to stand on coarse terrain too. */
const SINK = 1.5;

/** Where the camera is; the LOD follows it in the shadow pass too. */
export const treeViewer = uniform(new Vector3());
/**
 * Every tree is drawn this close; further out, a share falling with the
 * square of distance (so trees per pixel stay steady), out to the far limit.
 */
export const treeFullDistance = uniform(600);
export const treeMaxDistance = uniform(6000);
/** Wind, m/s, x east and z south. */
export const treeWind = uniform(new Vector2());

/** How far thinned crowns grow to fill in for the trees they stand for. */
const FILL_MAX = 1.6;

/** Share of a tile's trees drawn at a distance. Mirrors drawnShare(). */
function share(distance) {
  const ratio = treeFullDistance.div(max(distance, 1));
  return min(ratio.mul(ratio), 1).mul(
    smoothstep(treeMaxDistance, treeMaxDistance.mul(0.8), distance)
  );
}

/** Share of a tile's trees drawn at a distance, for the CPU's counts. */
export function drawnShare(distance: number) {
  if (distance >= treeMaxDistance.value) return 0;
  const ratio = treeFullDistance.value / Math.max(distance, 1);
  return Math.min(ratio * ratio, 1);
}

/**
 * Tile meshes carry `userData.tile`: (minX, minZ, size, count), the tile's
 * corner and side in world x/z and its tree count.
 */
export function createTreeMaterial({ encoding }: TreesManifest) {
  const tile = uniform(new Vector4()).onObjectUpdate(
    ({ object }) => object.userData.tile
  );
  // x, z (0..1 over the tile), ground, height << 8 | radius, as u16
  const tree = attribute("tree", "vec4");
  const lathe = attribute("lathe", "vec4");

  const x = tile.x.add(tree.x.mul(tile.z));
  const z = tile.y.add(tree.y.mul(tile.z));
  const ground = tree.z
    .mul(65535)
    .div(encoding.ground.scale)
    .sub(encoding.ground.offset);
  const packed = tree.w.mul(65535).add(0.5).floor();
  const high = floor(packed.div(256));
  let height: any = high.mul(encoding.heightStep);
  let radius: any = packed.sub(high.mul(256)).mul(encoding.radiusStep);

  const xq = tree.x.mul(65535);
  const zq = tree.y.mul(65535);
  const seed = hash(xq.add(hash(zq).mul(1e6)));
  const random = (k: number) => hash(seed.mul(1e6).add(k));

  // Thin out with distance: this tree's rank in its tile's order against the
  // share drawn where it stands; the last of them shrink away, not pop.
  const base = vec3(x, ground.mul(verticalScale), z);
  const distance = base.sub(treeViewer).length();
  const drawn = share(distance);
  const rank = float(instanceIndex).add(0.5).div(tile.w);
  const kept = smoothstep(drawn, drawn.mul(0.8), rank);
  // The ones left grow to cover for the rest.
  const fill = clamp(pow(max(drawn, 1e-3), -0.2), 1, FILL_MAX).mul(kept);
  radius = radius.mul(fill);
  height = height.mul(fill);

  // Proportions: tall, narrow trees taper (pines, Norfolk pines); broad
  // ones are domes (pōhutukawa, oaks). Crowns are about as deep as they're
  // wide, within reason for the trunk under them.
  const slender = height.div(max(radius.mul(2), 0.5));
  const conical = smoothstep(1.3, 2.6, slender.mul(mix(0.8, 1.25, random(1))));
  const depth = clamp(
    radius.mul(mix(1.6, 2.2, random(2))),
    height.mul(0.45),
    height.mul(0.9)
  );
  const crownBase = height.sub(depth);

  const t = lathe.z;
  const isTrunk = lathe.w;
  const dome = pow(sin(t.mul(Math.PI)), 0.7);
  const cone = select(t.lessThan(0.01), float(0), float(1.05).sub(t));
  const profile = mix(dome, cone, conical);
  const lump = float(1).add(
    hash(seed.mul(1e4).add(float(vertexIndex))).sub(0.5).mul(LUMPS * 2)
  );
  const crownRadius = radius.mul(profile).mul(lump);
  const trunkRadius = clamp(height.mul(0.025), 0.12, 0.6).mul(kept);

  const turn = random(3).mul(Math.PI * 2);
  const c = cos(turn);
  const s = sin(turn);
  const around = vec2(
    lathe.x.mul(c).sub(lathe.y.mul(s)),
    lathe.x.mul(s).add(lathe.y.mul(c))
  );
  const across = around.mul(mix(crownRadius, trunkRadius, isTrunk));
  const up = mix(
    crownBase.add(t.mul(depth)),
    mix(float(-SINK), crownBase.add(depth.mul(0.3)), t),
    isTrunk
  );

  // Crowns lean downwind and sway, the tops most.
  const gust = sin(time.mul(mix(1.1, 1.7, random(4))).add(random(5).mul(6.28)));
  const lean = treeWind
    .mul(float(0.012).add(gust.mul(0.006)))
    .mul(t.mul(t).mul(depth).mul(0.25))
    .mul(float(1).sub(isTrunk));

  const material = new MeshLambertNodeMaterial();
  material.positionNode = base.add(
    vec3(across.x.add(lean.x), up, across.y.add(lean.y))
  );

  // Smooth normals from an ellipsoid around the crown, mixed with facet
  // normals so they read as low-poly like the buildings.
  const centre = crownBase.add(depth.mul(mix(0.5, 0.35, conical)));
  const shape = varying(
    vec3(
      across.x.div(max(radius.mul(radius), 0.01)),
      up.sub(centre).div(max(depth.mul(depth).mul(0.25), 0.01)),
      across.y.div(max(radius.mul(radius), 0.01))
    )
  );
  const trunkNormal = varying(vec3(around.x, 0, around.y));
  const part = varying(isTrunk);
  const height01 = varying(t);
  const smooth = normalize(mix(shape, trunkNormal, part));
  let flat: any = normalize(cross(dFdx(positionWorld), dFdy(positionWorld)));
  flat = flat.mul(sign(flat.dot(smooth)));
  material.normalNode = transformNormalToView(
    normalize(mix(smooth, flat, FACETS))
  );

  const tone = varying(random(6));
  const foliage = mix(FOLIAGE[0], FOLIAGE[1], tone).mul(
    mix(1, 0.7, varying(conical))
  );
  // Self-shade: the underside and inside of the crown are darker.
  const inside = mix(0.6, 1, smoothstep(0, 0.9, height01));
  material.colorNode = vec3(
    mix(foliage.mul(inside), float(BARK), part)
  );

  return material;
}
