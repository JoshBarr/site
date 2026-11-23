import {
  MeshLambertNodeMaterial,
  Vector2,
  Vector3,
  Vector4,
} from "three/webgpu";
import {
  attribute,
  clamp,
  cos,
  float,
  floor,
  hash,
  instanceIndex,
  max,
  min,
  mix,
  mx_noise_vec3,
  normalize,
  positionWorld,
  pow,
  select,
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
import { LOBES } from "./geometry";
import type { TreesManifest } from "./manifest";

// Trees in the scene's greys: dark crowns, darker underneath and between
// trees. Each is placed and sized from the lidar (see build_trees.py) and
// shaped from its proportions: tall, narrow crowns taper like conifers,
// wide ones are rounded.
//
// Two levels of detail, the same tree in more or fewer lobes. Far off, trees
// are drawn per tile (Trees.tsx). Inside `treeNearDistance` they're drawn
// from instances gathered around the camera; the two swap at the same
// distance, so each tree is drawn by exactly one of them.

/** Foliage albedo, from dark pines to paler broadleaf. */
const FOLIAGE = [0.035, 0.085];
const BARK = 0.05;

/** Lobe radius jitter per vertex, ±. */
const LOBE_LUMPS = 0.14;

/** Trunks start this far underground, to stand on coarse terrain too. */
const SINK = 1.5;

/**
 * Leaf clumps shaded into near crowns: noise this many metres across, its
 * strength, and where it fades out (it would shimmer smaller than a pixel).
 */
const CLUMP_SIZE = 1.6;
const CLUMP_STRENGTH = 0.55;
const CLUMP_FADE = [80, 220];

/** Where the camera is; the LOD follows it in the shadow pass too. */
export const treeViewer = uniform(new Vector3());

/**
 * Every tree is drawn this close; further out, a share falling with the
 * square of distance (so trees per pixel stay steady), out to the far limit.
 */
export const treeFullDistance = uniform(600);
export const treeMaxDistance = uniform(6000);

/** Closer than this, trees are drawn with lobed crowns. */
export const treeNearDistance = uniform(250);

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
 * One tree from its packed record: where it stands, how big, its random
 * numbers and its crown's proportions. `tile` is (minX, minZ, size, count);
 * `rank` its place in the tile's order, 0..1, or 0 to keep it whatever the
 * distance (near trees are all inside the full distance).
 */
function decodeTree(
  { encoding }: TreesManifest,
  tile: any,
  tree: any,
  rank: any,
  near: boolean
) {
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
  const inside = distance.lessThan(treeNearDistance);
  // Each tree is drawn by one of the two levels.
  const ours = select(inside, float(near ? 1 : 0), float(near ? 0 : 1));
  const kept = smoothstep(drawn, drawn.mul(0.8), rank).mul(ours);
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
  const trunkRadius = clamp(height.mul(0.025), 0.12, 0.6).mul(kept);

  const turn = random(3).mul(Math.PI * 2);

  /** A horizontal (x, z) turned by the tree's own random turn. */
  const turned = (v: any) => {
    const c = cos(turn);
    const s = sin(turn);

    return vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));
  };

  return {
    base,
    distance,
    height,
    radius,
    depth,
    crownBase,
    conical,
    trunkRadius,
    seed,
    random,
    turned,
  };
}

type Tree = ReturnType<typeof decodeTree>;

/**
 * Place the shaped vertex, leaning downwind and swaying, the tops most;
 * set the material's position, shadow position and colour.
 */
function finish(
  material: MeshLambertNodeMaterial,
  tree: Tree,
  {
    across,
    up,
    reach,
    part,
    shade,
  }: {
    /** Horizontal offset from the trunk's axis, m. */
    across: any;
    /** Height above the ground, m. */
    up: any;
    /** How far the vertex leans in the wind. */
    reach: any;
    /** 1 on the trunk. */
    part: any;
    /** Foliage light, 0..1: self-shading in the crown. */
    shade: any;
  }
) {
  const { base, random } = tree;
  const gust = sin(time.mul(mix(1.1, 1.7, random(4))).add(random(5).mul(6.28)));
  const lean = treeWind.mul(float(0.012).add(gust.mul(0.006))).mul(reach);

  const leaned = (by: any) =>
    base.add(vec3(across.x.add(by.x), up, across.y.add(by.y)));

  material.positionNode = leaned(lean);
  // Shadows lean without the sway: the near map only redraws ten times a
  // second when nothing else changes.
  material.castShadowPositionNode = leaned(treeWind.mul(0.012).mul(reach));

  const tone = varying(random(6));

  const foliage = mix(FOLIAGE[0], FOLIAGE[1], tone).mul(
    mix(1, 0.7, varying(tree.conical))
  );

  const bark: any = varying(part);
  material.colorNode = vec3(mix(foliage.mul(varying(shade)), BARK, bark));
}

/**
 * A level of the trees. Far: one mesh per tile, carrying `userData.tile`:
 * (minX, minZ, size, count), the tile's corner and side in world x/z and its
 * tree count. Near: the same records gathered around the camera, each with
 * its tile beside it (Trees.tsx).
 */
export function createTreeMaterial(
  manifest: TreesManifest,
  detail: "near" | "far"
) {
  const near = detail === "near";
  const lobes = LOBES[detail];

  const tile = near
    ? attribute("treeTile", "vec4")
    : uniform(new Vector4()).onObjectUpdate(
        ({ object }) => object?.userData.tile
      );

  // x, z (0..1 over the tile), ground, height << 8 | radius, as u16
  const tree = attribute("tree", "vec4");
  const lobe = attribute("lobe", "vec4");
  // Near trees are all inside the full distance: none are thinned.
  const rank = near ? float(0) : float(instanceIndex).add(0.5).div(tile.w);
  const decoded = decodeTree(manifest, tile, tree, rank, near);
  const { radius, depth, crownBase, conical, seed, random } = decoded;
  // Fewer lobes are bigger, to fill the same crown.
  const fewer = (LOBES.near / lobes) ** 0.4;

  const k = lobe.w;
  const isTrunk = select(k.lessThan(0), float(1), float(0));
  const kr = (n: number) => hash(seed.mul(1e5).add(k.mul(17)).add(n));

  // Where each lobe sits, in the crown's own units: across in radii from
  // the axis, up from the crown's base in depths; and its size in radii.
  // Domes: one lobe on top, the rest in a ring round its shoulders.
  // Cones: stacked, smaller up the tree, spiralling round the trunk.
  const ring = k.sub(1).div(lobes - 1);
  const top = select(k.lessThan(0.5), float(1), float(0));
  const domeAngle = ring.add(kr(1).mul(0.12)).mul(Math.PI * 2);
  const domeOut = mix(mix(0.46, 0.6, kr(2)), mix(0.05, 0.2, kr(2)), top);
  const domeUp = mix(mix(0.32, 0.5, kr(3)), mix(0.6, 0.68, kr(3)), top);

  const domeSize = mix(
    mix(0.45, 0.58, kr(4)).mul(fewer),
    mix(0.55, 0.68, kr(4)),
    top
  );

  const level = float(1).sub(k.add(0.6).div(lobes).mul(0.92));
  const coneAngle = k.mul(2.39996).add(random(8).mul(6.28));

  const coneOut = float(1)
    .sub(level)
    .mul(mix(0.35, 0.5, kr(2)));

  const coneUp = level;

  const coneSize = float(1)
    .sub(level)
    .mul(0.5)
    .add(mix(0.16, 0.24, kr(4)))
    .mul(fewer);

  const angle = mix(domeAngle, coneAngle, conical);
  const out = mix(domeOut, coneOut, conical);
  const lift = mix(domeUp, coneUp, conical);
  const size = mix(domeSize, coneSize, conical).mul(radius);

  const centreAcross = decoded
    .turned(vec2(cos(angle), sin(angle)))
    .mul(out.mul(radius));

  const centreUp = crownBase.add(lift.mul(depth));

  const lump = float(1).add(
    hash(seed.mul(1e4).add(float(vertexIndex)))
      .sub(0.5)
      .mul(LOBE_LUMPS * 2)
  );

  // Lobes are a little flattened, as foliage clumps are.
  const reach3 = vec3(lobe.x, lobe.y.mul(0.82), lobe.z).mul(size.mul(lump));
  const lobeAcross = centreAcross.add(vec2(reach3.x, reach3.z));
  const lobeUp = centreUp.add(reach3.y);

  // The trunk runs up into the crown, tapering.
  const t = lobe.y;
  const trunkWidth = decoded.trunkRadius.mul(mix(1.15, 0.6, t));

  const trunkAcross = decoded
    .turned(vec2(lobe.x, lobe.z))
    .mul(trunkWidth.mul(1.2));

  const trunkUp = mix(float(-SINK), crownBase.add(depth.mul(0.55)), t);

  const across = lobeAcross
    .mul(float(1).sub(isTrunk))
    .add(trunkAcross.mul(isTrunk));

  const up = mix(lobeUp, trunkUp, isTrunk);

  // Normals: the lobe's own, leaned toward the whole crown's so the crown
  // still reads as one mass under the sun.
  const crownCentre = crownBase.add(depth.mul(mix(0.5, 0.35, conical)));

  const crownNormal = normalize(
    vec3(
      across.x.div(max(radius.mul(radius), 0.01)),
      up.sub(crownCentre).div(max(depth.mul(depth).mul(0.25), 0.01)),
      across.y.div(max(radius.mul(radius), 0.01))
    )
  );

  const lobeNormal = vec3(lobe.x, lobe.y.div(0.82), lobe.z);
  const foliageNormal = normalize(mix(normalize(lobeNormal), crownNormal, 0.4));

  // Lobe faces turned in toward the crown's middle, and the crown's
  // underside, sit in its own shade.
  const facing = foliageNormal.dot(crownNormal).mul(0.5).add(0.5);
  const heightIn = up.sub(crownBase).div(max(depth, 0.1));

  const shade = mix(0.35, 1, smoothstep(0.1, 0.85, facing)).mul(
    mix(0.6, 1, smoothstep(0, 0.9, heightIn))
  );

  const material = new MeshLambertNodeMaterial();

  finish(material, decoded, {
    across,
    up,
    reach: heightIn
      .mul(heightIn)
      .mul(depth)
      .mul(0.25)
      .mul(float(1).sub(isTrunk)),
    part: isTrunk,
    shade,
  });

  const trunkNormal = vec3(trunkAcross.x, 0, trunkAcross.y);

  const smooth = normalize(
    mix(varying(foliageNormal), varying(trunkNormal), varying(isTrunk))
  );

  if (!near) {
    material.normalNode = transformNormalToView(smooth);

    return material;
  }

  // Leaf clumps, close up: world-space noise tips the normals about.
  const clumps = varying(
    smoothstep(CLUMP_FADE[1], CLUMP_FADE[0], decoded.distance)
      .mul(CLUMP_STRENGTH)
      .mul(float(1).sub(isTrunk))
  );

  const wobble = mx_noise_vec3(positionWorld.div(CLUMP_SIZE)).mul(clumps);
  material.normalNode = transformNormalToView(normalize(smooth.add(wobble)));

  return material;
}
