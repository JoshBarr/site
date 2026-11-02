import { DataTexture, Texture, Vector4 } from "three/webgpu";
import {
  clamp,
  float,
  max,
  mix,
  normalize,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { AirfieldMaps, shadeAirfield } from "../airport/surface";

// Ground cover for the terrain, in greys: what grows there from the land
// cover map, its texture from a tiling detail map, ridges lit and gullies
// shaded from the tiles' relief channel, and the airport's paving.

/** Must match SLOPE_SCALE in detailWorker. */
const DETAIL_SLOPE_SCALE = 4;
export const DETAIL_SIZE = 256;
/** Metres per repeat of the detail map for shrubs; trees are larger. */
const SHRUB_PERIOD = 80;
const TREE_PERIOD = 190;
/** Crown heights the bumps are lit as, in metres. */
const SHRUB_HEIGHT = 1.5;
const TREE_HEIGHT = 5;

/** Albedos. Dense vegetation is dark; grass, rock and sand are paler. */
const GRASS = 0.15;
const SCRUB = 0.06;
const FOREST = 0.04;
const URBAN = 0.1;
const ROCK = 0.2;
const SAND = 0.26;
/** Roofs range from black iron to white membrane around this. */
const ROOF = 0.12;

export interface SurfaceMaps {
  /** Forest, scrub and urban fractions (R, G, B). */
  landcover: Texture;
  /** Land cover extent in world x/z: (west, north, width, height). */
  landcoverBounds: ReturnType<typeof createLandcoverBounds>;
  /** From detailWorker. */
  detail: DataTexture;
  airfield: AirfieldMaps;
}

export function createLandcoverBounds() {
  return uniform(new Vector4(0, 0, 1, 1));
}

/** Slope of the detail map's canopy, in metres per metre, at a scale. */
function canopySlope(sample, period: number, height: number) {
  const perMetre = (DETAIL_SIZE / period / DETAIL_SLOPE_SCALE) * height;
  return sample.gb.sub(0.5).mul(perMetre);
}

/**
 * Colour, normal and ambient occlusion for ground at world x/z `world`.
 * `height` is in metres (unscaled), `normal` the world-space terrain normal,
 * `relief` 0..1 with 0.5 for level ground, `building` 0..1 cover by
 * building footprints.
 */
export function shadeSurface(
  { landcover, landcoverBounds, detail, airfield }: SurfaceMaps,
  { world, height, normal, relief, building }
) {
  // The aerodrome is grass and paving, whatever the land cover map says.
  const airport = shadeAirfield(airfield, { world, detail });
  const open = float(1).sub(airport.field);

  // Blotches at two scales: break up edges and vary the tone. Each blends
  // two samples at unrelated scales and angles so the tiling doesn't show.
  const blotches = (period: number) =>
    texture(detail, world.div(period))
      .a.add(
        texture(detail, vec2(world.y, world.x.negate()).div(period * 1.618)).a
      )
      .mul(0.5);
  const broad = blotches(SHRUB_PERIOD * 7.3);
  const fine = blotches(SHRUB_PERIOD * 1.37);

  // Land cover, with its edges wobbled so they don't read as map polygons.
  const wobble = vec2(broad, fine).sub(0.5).mul(70);
  const uv = world
    .add(wobble)
    .sub(landcoverBounds.xy)
    .div(landcoverBounds.zw);
  const cover = texture(landcover, uv).rgb;
  // Fade out at the map's edge rather than stopping on a line.
  const inside = smoothstep(0, 0.03, uv.x)
    .mul(smoothstep(1, 0.97, uv.x))
    .mul(smoothstep(0, 0.03, uv.y))
    .mul(smoothstep(1, 0.97, uv.y));
  const sharpen = (v) =>
    smoothstep(0.3, 0.7, v.add(fine.sub(0.5).mul(0.5))).mul(inside);
  const forest = sharpen(cover.r).mul(open);
  const urban = sharpen(cover.b).mul(open);
  // Scrub fills gullies wherever the map says nothing else.
  const gullies = smoothstep(0.42, 0.3, relief.add(broad.sub(0.5).mul(0.15)));
  const scrub = max(
    sharpen(cover.g),
    gullies.mul(float(1).sub(urban)).mul(float(1).sub(forest)).mul(0.8)
  ).mul(open);

  // Bare where it's steep, unless something grows there.
  const steep = smoothstep(0.78, 0.6, normal.y)
    .mul(float(1).sub(urban))
    .mul(float(1).sub(forest));
  const shore = smoothstep(1.5, 0.5, height).mul(float(1).sub(urban));

  // Crowns: small shrubs, and trees on a larger, turned grid.
  const shrubs = texture(detail, world.div(SHRUB_PERIOD));
  const treeUV = vec2(world.y, world.x.negate()).div(TREE_PERIOD);
  const trees = texture(detail, treeUV);
  const treeSlope = canopySlope(trees, TREE_PERIOD, TREE_HEIGHT);
  // Turn the tree map's slope back into world axes.
  const treeWorld = vec2(treeSlope.y.negate(), treeSlope.x);
  const shrubSlope = canopySlope(shrubs, SHRUB_PERIOD, SHRUB_HEIGHT);

  const bushiness = scrub
    .add(float(1).sub(scrub).mul(0.15))
    .mul(float(1).sub(forest))
    .mul(float(1).sub(steep.mul(0.6)))
    .mul(float(1).sub(building))
    .mul(float(1).sub(airport.paved));
  const slope = shrubSlope.mul(bushiness).add(treeWorld.mul(forest));
  const detailed = normalize(vec3(normal).sub(vec3(slope.x, 0, slope.y)));

  // Tone: grass, overgrown by scrub and forest, built over, bared on cliffs
  // and at the shore.
  let albedo: any = float(GRASS).mul(mix(0.82, 1.12, broad));
  albedo = mix(
    albedo,
    float(SCRUB)
      .mul(mix(0.55, 1.2, shrubs.r))
      .mul(mix(0.8, 1.2, fine)),
    scrub
  );
  // Canopy over the town: the lidar finds bush and back-yard trees inside
  // land OpenStreetMap calls residential.
  albedo = mix(albedo, float(URBAN).mul(mix(0.8, 1.2, fine)), urban);
  albedo = mix(albedo, float(FOREST).mul(mix(0.45, 1.25, trees.r)), forest);
  albedo = mix(albedo, float(ROCK).mul(mix(0.8, 1.1, fine)), steep);
  albedo = mix(albedo, float(SAND), shore);
  albedo = mix(albedo, albedo.mul(airport.mowing), airport.field);
  albedo = mix(albedo, airport.albedo, airport.paved);
  // Roofs, each its own shade (near enough: the blotches are roof-sized),
  // outlined where the footprint's edge is filtered.
  const roof = float(ROOF).mul(
    mix(0.35, 1.9, texture(detail, world.div(37)).a)
  );
  albedo = mix(albedo, roof, building);
  albedo = albedo.mul(
    float(1).sub(building.mul(float(1).sub(building)).mul(1.6))
  );

  // Ridges catch the light; gullies sit in shade.
  const lift = clamp(relief, 0, 1);
  albedo = albedo.mul(mix(0.45, 1.5, lift));
  const occlusion = mix(0.3, 1, smoothstep(0.1, 0.6, lift));

  return { color: vec3(albedo), normal: detailed, occlusion };
}
