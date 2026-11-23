import { MeshLambertNodeMaterial, Vector4 } from "three/webgpu";
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
  normalize,
  pow,
  select,
  sin,
  smoothstep,
  transformNormalToView,
  uniform,
  varying,
  vec2,
  vec3,
  vertexIndex,
} from "three/tsl";
import { SHRUB_LOBES } from "./geometry";
import { treeViewer } from "./material";

// Shrubs where the lidar found scrub (gorse, flax, mānuka, hedges) too low
// to be trees: a few lobes each, in the scene's greys, a little paler than
// the trees.

/** Foliage albedo, from dark gorse to paler flax. */
const FOLIAGE = [0.04, 0.075];

/** Lobe radius jitter per vertex, ±. */
const LUMPS = 0.16;

/** Shrubs start this far underground, m, to sit on coarse terrain too. */
const SHRUB_SINK = 0.25;

/**
 * Every shrub is drawn this close; further out, a share falling with the
 * square of distance, out to the far limit. As the trees'.
 */
export const shrubFullDistance = uniform(250);
export const shrubMaxDistance = uniform(900);

/** How far thinned shrubs grow to fill in for the ones they stand for. */
const FILL_MAX = 1.5;

/** Size is packed into one float: radius in cm × SIZE_SPLIT + height in cm. */
export const SIZE_SPLIT = 1000;

/** Share of a chunk's shrubs drawn at a distance, for the CPU's counts. */
export function shrubShare(distance: number) {
  if (distance >= shrubMaxDistance.value) return 0;
  const ratio = shrubFullDistance.value / Math.max(distance, 1);

  return Math.min(ratio * ratio, 1);
}

/**
 * Chunk meshes carry `userData.chunk`: (count, 0, 0, 0). Each instance is
 * (x, ground, z, size): world position at its foot (ground scaled) and its
 * packed radius and height.
 */
export function createShrubMaterial() {
  const chunk = uniform(new Vector4()).onObjectUpdate(
    ({ object }) => object?.userData.chunk
  );

  const shrub = attribute("shrub", "vec4");
  const lobe = attribute("lobe", "vec4");

  const base = shrub.xyz;
  const radiusCm = floor(shrub.w.div(SIZE_SPLIT));
  let radius: any = radiusCm.div(100);
  let height: any = shrub.w.sub(radiusCm.mul(SIZE_SPLIT)).div(100);

  const seed = hash(base.x.mul(7.13).add(hash(base.z.mul(3.71)).mul(1e5)));
  const random = (k: number) => hash(seed.mul(1e6).add(k));

  // Thinned with distance as the trees are: the last of a chunk's order
  // shrink away, and the ones left grow to cover for them.
  const distance = base.sub(treeViewer).length();
  const ratio = shrubFullDistance.div(max(distance, 1));

  const drawn = min(ratio.mul(ratio), 1).mul(
    smoothstep(shrubMaxDistance, shrubMaxDistance.mul(0.8), distance)
  );

  const rank = float(instanceIndex).add(0.5).div(max(chunk.x, 1));
  const kept = smoothstep(drawn, drawn.mul(0.8), rank);
  const fill = clamp(pow(max(drawn, 1e-3), -0.2), 1, FILL_MAX).mul(kept);
  radius = radius.mul(fill);
  height = height.mul(fill);

  // Lobe 0 in the middle, the rest around it, lower.
  const k = lobe.w;
  const middle = select(k.lessThan(0.5), float(1), float(0));
  const kr = (n: number) => hash(seed.mul(1e5).add(k.mul(17)).add(n));

  const angle = k
    .div(SHRUB_LOBES - 1)
    .add(random(1))
    .add(kr(1).mul(0.15))
    .mul(Math.PI * 2);

  const out = mix(mix(0.42, 0.58, kr(2)), mix(0, 0.12, kr(2)), middle).mul(
    radius
  );

  const size: any = mix(
    mix(0.48, 0.6, kr(3)),
    mix(0.6, 0.7, kr(3)),
    middle
  ).mul(radius);

  // Lobes as tall as the shrub, squashed or stretched from round.
  const tall: any = mix(mix(0.36, 0.44, kr(4)), 0.5, middle).mul(height);
  const centreUp = height.sub(tall).mul(mix(0.85, 1, middle));
  const centre = vec2(cos(angle), sin(angle)).mul(out);

  const lump = float(1).add(
    hash(seed.mul(1e4).add(float(vertexIndex)))
      .sub(0.5)
      .mul(LUMPS * 2)
  );

  const across = centre.add(vec2(lobe.x, lobe.z).mul(size).mul(lump));
  const up = centreUp.add(lobe.y.mul(tall).mul(lump)).sub(SHRUB_SINK);

  const material = new MeshLambertNodeMaterial();
  material.positionNode = base.add(vec3(across.x, up, across.y));

  // Normals: each lobe's own, leaned toward the whole shrub's dome.
  const domeNormal = normalize(
    vec3(
      across.x.div(max(radius, 0.1)),
      up.div(max(height, 0.1)).mul(1.2),
      across.y.div(max(radius, 0.1))
    )
  );

  const lobeNormal = normalize(
    vec3(lobe.x.div(size), lobe.y.div(max(tall, 0.05)), lobe.z.div(size))
  );

  const normal = normalize(mix(lobeNormal, domeNormal, 0.45));
  material.normalNode = transformNormalToView(normalize(varying(normal)));

  // Underneath and between lobes in their own shade.
  const facing = normal.dot(domeNormal).mul(0.5).add(0.5);
  const lift = clamp(up.add(SHRUB_SINK).div(max(height, 0.1)), 0, 1);

  const shade = mix(0.45, 1, smoothstep(0.15, 0.85, facing)).mul(
    mix(0.55, 1, lift)
  );

  const tone = mix(FOLIAGE[0], FOLIAGE[1], random(2));
  material.colorNode = vec3(varying(tone.mul(shade)));

  return material;
}
