import { DoubleSide, MeshStandardNodeMaterial } from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  hash,
  max,
  min,
  mix,
  mx_noise_float,
  normalWorld,
  positionWorld,
  smoothstep,
  step,
  uniform,
  varying,
  vec2,
  vec3,
} from "three/tsl";
import { verticalScale } from "../terrain/Terrain";
import { createFloodlights } from "./floodlights";
import type { BuildingsManifest, EncodedRange } from "./manifest";

// Buildings in the scene's greys: one tone per building, roofs from black
// iron to pale membrane like the terrain's footprints, weathered with noise
// in world space, darker toward the street.

/** Wall albedo range: dark brick and glass to pale concrete. */
const WALL = [0.12, 0.3];

/** Roofs, as the terrain shades footprints (surface.ts ROOF). */
const ROOF = 0.12;
const ROOF_SPREAD = [0.35, 1.9];

/** Walls darken over this many metres above the ground. */
const STREET_SHADE = 10;

/** Fine weathering fades out by this distance, where it would shimmer. */
const FINE_DETAIL_DISTANCE = 900;

/**
 * 0..1: how far through lighting-up, for night. Each window comes on at its
 * own moment in it, so the share lit climbs from none to windowsLit.
 */
export const windowLights = uniform(0);

/** Share of windows with a light on, by the hour (see windowsLitAt). */
export const windowsLit = uniform(0.4);

/** Storey height and window bay width, metres. */
export const STOREY = 3.4;
export const BAY = 3;

/** Glass within each bay and storey, 0..1 across and up. */
const PANE_ACROSS = [0.18, 0.82];
const PANE_UP = [0.3, 0.85];
const GLASS = (PANE_ACROSS[1] - PANE_ACROSS[0]) * (PANE_UP[1] - PANE_UP[0]);

/** A share of buildings with every light off. */
const DARK_BUILDINGS = 0.25;

/**
 * Near white, for the scene's greys: a touch warm for homes, a touch cool
 * for the odd office tube.
 */
export const WARM = vec3(1, 0.96, 0.9);
export const COOL = vec3(0.92, 0.96, 1);
export const COOL_SHARE = 0.35;
export const WINDOW_BRIGHTNESS = 2;

/** Lit windows run 0.4 to 1.2 bright: on average. */
const WINDOW_MEAN = 0.8;

/**
 * Windows fade out as they shrink under a pixel, by bays or storeys per
 * pixel; the building's lights take over (see lights.ts).
 */
export const UNRESOLVED = [0.5, 1.2];

/**
 * Buildings with blank walls (stadium, sheds; the tile build flags them in
 * the seed's top bit) get a lamp every so often instead, at this height,
 * this share of them on all night.
 */
const LAMP_SPACING = 18;
const LAMP_HEIGHT = [3.6, 4.2];
const LAMP_WIDTH = 0.7;
const LAMPS_LIT = 0.5;
const LAMP_BRIGHTNESS = 2;

/**
 * Uplights at a landmark's foot: this far apart, metres, each a pool this
 * wide at the ground and widening by this much per metre up.
 */
const UPLIGHT_SPACING = 6;
const UPLIGHT_WIDTH = 0.8;
const UPLIGHT_SPREAD = 0.35;

/** More windows lit at street level, times. */
export const STREET_BUSIER = 1.6;

/**
 * Light from a lit window share of a wall, per m² of wall: what its windows
 * average out to when they're too small to see.
 */
export const WINDOW_GLOW = WINDOW_MEAN * GLASS;

/** Light from a blank wall's lamps, per metre along it. */
export const LAMP_GLOW =
  (LAMP_WIDTH *
    (LAMP_HEIGHT[1] - LAMP_HEIGHT[0]) *
    LAMPS_LIT *
    LAMP_BRIGHTNESS) /
  LAMP_SPACING;

// Lights on through the evening, dwindling after midnight; Wellington time.
// [hour, share lit]
const OCCUPANCY: [number, number][] = [
  [0, 0.14],
  [2, 0.07],
  [5, 0.05],
  [7, 0.16],
  [17, 0.22],
  [19, 0.28],
  [22, 0.22],
  [24, 0.14],
];

/** Share of the city's windows lit at a given moment. */
export function windowsLitAt(date: Date) {
  const parts = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);

  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  const hour = part("hour") + part("minute") / 60;
  const next = OCCUPANCY.findIndex(([h]) => h > hour);
  const [h0, v0] = OCCUPANCY[next - 1];
  const [h1, v1] = OCCUPANCY[next];

  return v0 + ((v1 - v0) * (hour - h0)) / (h1 - h0);
}

/**
 * Share of a building's windows lit on one storey: none in the dark ones,
 * and `street` times more at street level.
 */
export function windowShare(seed, street) {
  const occupied = hash(seed.add(104729));

  return min(
    windowsLit
      .mul(mix(0.2, 1.8, occupied))
      .mul(step(DARK_BUILDINGS, occupied))
      .mul(street),
    1
  );
}

/** 1 between lo and hi, edges softened over w. */
const band = (x, [lo, hi]: number[], w) =>
  smoothstep(w.negate(), w, x.sub(lo)).mul(
    smoothstep(w.negate(), w, float(hi).sub(x))
  );

/**
 * Tile meshes are scaled from 0..1 to their bounds in x/z; heights are
 * metres. Geometry has no normals, so it's flat shaded from screen-space
 * derivatives, which also means stray back faces light like front faces:
 * it's drawn double-sided rather than trusting every wall's winding.
 */
export function createBuildingMaterial({
  encoding,
  origin,
}: BuildingsManifest) {
  // x, z (0..1 over the tile), rel, delta
  const quantised = attribute("quantised", "vec4");
  // ground, seed
  const building = attribute("building", "vec2");
  const decode = (q, { min, range }: EncodedRange) => q.mul(range).add(min);

  const rel = decode(quantised.z, encoding.rel);
  const delta = decode(quantised.w, encoding.rel);
  const ground = decode(building.x, encoding.ground);

  const material = new MeshStandardNodeMaterial({
    roughness: 0.85,
    metalness: 0,
    side: DoubleSide,
  });

  // The terrain is drawn exaggerated about sea level; buildings keep their
  // real height on top of it.
  material.positionNode = vec3(
    quantised.x,
    ground.mul(verticalScale).add(rel),
    quantised.y
  );

  const aboveGround: any = varying(rel.sub(delta.mul(verticalScale)));
  // The same for every vertex of a building.
  const seed = varying(building.y).mul(65535);
  const tone = hash(seed);
  const roofTone = hash(seed.add(7919));
  const windowless = step(32767.5, seed);

  const roof = smoothstep(0.3, 0.6, abs(normalWorld.y));
  const wall = float(1).sub(roof);

  let albedo: any = mix(
    mix(WALL[0], WALL[1], tone),
    float(ROOF).mul(mix(ROOF_SPREAD[0], ROOF_SPREAD[1], roofTone)),
    roof
  );

  // Broad patches everywhere; on walls, streaks running down.
  const p = positionWorld;
  const patches = mx_noise_float(p.mul(vec3(0.08, 0.03, 0.08)));

  const fine = smoothstep(
    FINE_DETAIL_DISTANCE,
    FINE_DETAIL_DISTANCE * 0.3,
    p.sub(cameraPosition).length()
  );

  const streaks = mx_noise_float(
    vec3(p.x.mul(0.9), p.y.mul(0.06), p.z.mul(0.9))
  )
    .mul(wall)
    .mul(fine);

  const grain = mx_noise_float(p.mul(0.6)).mul(fine);
  albedo = albedo.mul(
    float(1).add(patches.mul(0.14)).add(streaks.mul(0.1)).add(grain.mul(0.05))
  );

  albedo = albedo.mul(
    mix(1, mix(0.55, 1, smoothstep(0, STREET_SHADE, aboveGround)), wall)
  );

  material.colorNode = vec3(albedo);

  // Windows by night: bays along each wall and storeys up it, a random few
  // lit in each building. Where a window shrinks under a pixel it fades
  // rather than sparkle, and the building's lights carry on for it.
  const across = vec2(normalWorld.z.negate(), normalWorld.x);
  const bay = dot(p.xz, across).div(max(across.length(), 1e-4)).div(BAY);
  const storey = aboveGround.div(STOREY);
  const footprint = vec2(fwidth(bay), fwidth(storey));

  const pane = band(fract(bay), PANE_ACROSS, footprint.x).mul(
    band(fract(storey), PANE_UP, footprint.y)
  );

  // Whole numbers for hash, which takes them as uints: bays from a 1e5 offset
  // (the map is ±7000 bays), storeys under 128.
  const level = max(floor(storey), 0);

  const id = hash(
    floor(bay)
      .add(1e5)
      .add(hash(seed.mul(128).add(level)).mul(1e6))
  );

  // Busier at street level: shops, lobbies, front rooms.
  const street = mix(STREET_BUSIER, 1, step(1, level));
  // Landmarks keep theirs on late.
  const floodlights = createFloodlights(origin);
  const hero = floodlights.lookup(p);

  const share = max(
    windowShare(seed, street),
    min(hero.windows.mul(street), 1)
  );

  // The lowest ids switch on first, so the lit ones only ever add to.
  const lit = step(id, share.mul(windowLights));
  const colour = mix(WARM, COOL, step(1 - COOL_SHARE, hash(id.mul(1e6))));

  const window = colour
    .mul(mix(0.4, 1.2, hash(id.mul(1e6).add(7))))
    .mul(pane)
    .mul(lit);

  const resolved = float(1).sub(
    smoothstep(UNRESOLVED[0], UNRESOLVED[1], max(footprint.x, footprint.y))
  );

  const windows = window.mul(resolved);

  const lampBay = bay.mul(BAY / LAMP_SPACING);
  const lampId = hash(floor(lampBay).add(1e5).add(hash(seed).mul(1e6)));
  const halfWidth = (LAMP_WIDTH / LAMP_SPACING) * 0.5;

  const lamp = band(
    fract(lampBay),
    [0.5 - halfWidth, 0.5 + halfWidth],
    fwidth(lampBay)
  )
    .mul(band(aboveGround, LAMP_HEIGHT, fwidth(aboveGround)))
    .mul(step(lampId, windowLights.mul(LAMPS_LIT)));

  const lampAverage =
    ((LAMP_WIDTH * (LAMP_HEIGHT[1] - LAMP_HEIGHT[0])) /
      (LAMP_SPACING * STOREY)) *
    LAMPS_LIT;

  const lamps = WARM.mul(
    mix(
      windowLights.mul(lampAverage),
      lamp.mul(LAMP_BRIGHTNESS),
      float(1).sub(smoothstep(0.03, 0.08, fwidth(lampBay)))
    )
  );

  // Only truly vertical faces: steep roofs don't get windows.
  const upright = float(1).sub(smoothstep(0.1, 0.25, abs(normalWorld.y)));

  // Uplights along a landmark's walls, each a pool of light spreading as it
  // climbs. Far off, where the pools blur together, their average.
  const along = dot(p.xz, across)
    .div(max(across.length(), 1e-4))
    .div(UPLIGHT_SPACING);

  const spread = aboveGround.mul(UPLIGHT_SPREAD).add(UPLIGHT_WIDTH);
  const offset = fract(along).sub(0.5).mul(UPLIGHT_SPACING).div(spread);

  const pools = mix(
    exp(offset.mul(offset).negate()),
    min(spread.mul(Math.sqrt(Math.PI) / UPLIGHT_SPACING), 1),
    smoothstep(0.15, 0.4, fwidth(along))
  );

  const flood = hero.flood
    .mul(pools)
    .mul(exp(max(aboveGround, 0).div(hero.reach).negate()))
    .mul(upright)
    .add(hero.crown.mul(roof));

  // Floodlights come on at dusk, ahead of most windows.
  material.emissiveNode = mix(windows, lamps, windowless)
    .mul(upright)
    .mul(WINDOW_BRIGHTNESS)
    .add(
      WARM.mul(albedo)
        .mul(flood)
        .mul(smoothstep(0, 0.2, windowLights))
    );

  material.addEventListener("dispose", () => floodlights.map.dispose());

  return material;
}
