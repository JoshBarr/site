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
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import {
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  linearDepth,
  log,
  log2,
  max,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  reflector,
  screenUV,
  select,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  varying,
  vec3,
  vec4,
  viewportLinearDepth,
} from "three/tsl";
import { TERRAIN_URL, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
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
import { COAST_URL, openSea } from "../farland/coast";
import { clearTo, earthDrop } from "../farland/air";
import {
  edgeFade,
  hazeColor,
  hazeTransmittance,
  outsideClearing,
} from "../haze";
import { OceanSimulation } from "./OceanSimulation";
import { quakeGlow } from "../quakes/glow";
import { hazeGlowAtNight } from "../skyglow";
import {
  createCascades,
  DEFAULT_CONDITIONS,
  OceanConditions,
} from "./spectrum";
import { useRenderer } from "../renderer";
import { switchedOff } from "../stats";
import { loadSeaWind, openWhitecaps, openWind, seaWindiness } from "./seaWind";
import { readDepths, seaStanding, setIncoming } from "./shelterMap";
import { windVector } from "../weather";

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

/**
 * The sea's drawn this far from the camera, m: to RADIUS in rings fine
 * enough for its waves, and on to FAR_RADIUS, past the terrain's root and
 * out around the South Island (../farland) to the horizon, in rings each
 * FAR_STEP of its radius wider than the last. Out there it's a flat sheet
 * (no wave's drawn past a few kilometres), bent over the Earth's curve.
 * Inside the camera's far plane.
 */
const RADIUS = 45000;
const FAR_RADIUS = 240000;
const FAR_STEP = 0.08;

/** How much of the mirror the sea shows, and the far sea, past the map. */
const MIRROR = 0.5;
const FAR_MIRROR = 0.3;

/** The last of it fades out over this share of FAR_RADIUS, so it has no rim. */
const RIM = 0.25;

/**
 * Past the root there's no depth map, nor shelter or wind maps: it's open
 * sea, this deep, m. Eased to over the last of the root, this share of its
 * half-width.
 */
const DEEP = 300;
const OPEN_OVER = 0.1;

/** How tight the sun's glint is off smooth water: the exponent of its lobe. */
const GLINT = 900;

/**
 * Disc of rings around the origin. Ring spacing grows with radius so cells
 * stay roughly square, which keeps vertex density matched to screen size.
 */
function createSurfaceGeometry(segments: number) {
  const radii = [0];
  const minStep = 1.5;

  while (radii[radii.length - 1] < FAR_RADIUS) {
    const r = radii[radii.length - 1];

    radii.push(
      r < RADIUS
        ? r + Math.max(minStep, (r * 2 * Math.PI) / segments)
        : Math.min(r * (1 + FAR_STEP), FAR_RADIUS)
    );
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

/**
 * How many standard deviations up a normal distribution leaves `share` of
 * it above (Abramowitz & Stegun 26.2.23, to 0.0005).
 */
function belowShare(share) {
  const t = sqrt(log(max(share, 1e-6)).mul(-2));

  return t.sub(
    t
      .mul(0.010328)
      .add(0.802853)
      .mul(t)
      .add(2.515517)
      .div(t.mul(0.001308).add(0.189269).mul(t).add(1.432788).mul(t).add(1))
  );
}

/** The mirror as it was: nudged a little by the drawn slope (?off=searough). */
function roughMirrorBefore(mirror: ReturnType<typeof reflector>, slope) {
  if (mirror.uvNode) mirror.uvNode = mirror.uvNode.add(slope.mul(0.12));

  return mirror.rgb;
}

/**
 * Half the mirror's spread, either side, in its slope's standard deviations,
 * and how much each tap counts: a Gaussian's, five taps across.
 */
const TAPS = [-1.6, -0.8, 0, 0.8, 1.6].map((at) => ({
  at,
  weight: Math.exp(-0.5 * at * at),
}));

/**
 * Winds at which the sea starts to lose its mirror and has lost it, m/s at
 * 10 m: under a light air, glassy; by a moderate breeze, as rough as its
 * waves.
 */
const GLASSY = 1;
const RUFFLED = 7;

/** The mirror smeared no further than this, of the screen's height. */
const WIDEST = 0.3;

/**
 * The mirror off a rough sea. A facet that leans toward the eye by a slope
 * s turns the reflected ray up by 2s, which on screen is s times the lens's
 * cot(fov / 2) of its height lower down; leaning sideways it turns the ray
 * sideways, by less the lower the eye looks across it. So the drawn waves
 * move the reflection that far, and the waves too fine to draw (`rough`,
 * their slope's variance) smear it up and down by as much, as the long
 * shimmering streaks a windy sea makes of a shore's lights. Without that a
 * gale left the far harbour a mirror of the hills, as still as a calm.
 *
 * Above the horizon the mirror has nothing in it (the reflected ray goes
 * down, under the sea), so nothing's taken from closer to it than the
 * pixel is.
 */
function roughMirror(mirror: ReturnType<typeof reflector>, slope, rough, view) {
  const base: any = mirror.uvNode!;
  // cot(fov / 2): the projection's y scale.
  // SAFETY: a mat4 node's element(i) is its column i, which three's types
  // leave off UniformNode.
  const lens = (cameraProjectionMatrix as any).element(1).y;

  // Along the ground, from the sea to the eye.
  const flat = view.xz.length();
  const eyeward = view.xz.div(max(flat, 1e-4));
  const leaning = slope.dot(eyeward).negate();
  const sideways = slope.dot(vec2(eyeward.y.negate(), eyeward.x));

  // Screen y runs down: lower on the screen is higher in the reflection.
  const moved = vec2(sideways.mul(view.y), leaning).mul(lens);

  // Where the horizon is, straight up the screen from here: where the way
  // to the eye, turned round and levelled, vanishes.
  const away = cameraProjectionMatrix.mul(
    cameraViewMatrix.mul(vec4(eyeward.x.negate(), 0, eyeward.y.negate(), 0))
  );

  const horizon = select(
    away.w.greaterThan(1e-4),
    float(0.5).sub(away.y.div(away.w).mul(0.5)),
    float(-1)
  );

  const nearest = mix(horizon, screenUV.y, 0.1);
  const spread: any = sqrt(rough.mul(0.5)).mul(lens).min(WIDEST);

  let sum: any = vec3(0);
  let total = 0;

  for (const { at, weight } of TAPS) {
    const uv = base.add(moved).add(vec2(0, spread.mul(at)));
    const kept = vec2(uv.x, max(uv.y, nearest));

    // The middle tap is the mirror itself, which keeps it in the material.
    if (at === 0) mirror.uvNode = kept;

    const tap = at === 0 ? mirror : mirror.sample(kept);

    sum = sum.add(tap.rgb.mul(weight));
    total += weight;
  }

  return sum.div(total);
}

/** Without a simulation the sea is flat but shaded the same way. */
function createMaterial(
  simulation: OceanSimulation | null,
  water: Texture,
  coast: Texture,
  index: TileIndex,
  quality: OceanQuality
) {
  const cascades = simulation?.cascades ?? [];
  const displacements = simulation?.displacement ?? [];
  const derivatives = simulation?.derivatives ?? [];
  const fftSize = simulation?.size ?? 1;
  const folding = simulation?.folding ?? uniform(new Vector3());
  const { rootSize } = index.manifest;
  const maxDepth = index.manifest.water?.maxDepth ?? 30;
  const sqrtEncoded = index.manifest.water?.encoding === "sqrt";

  // The mesh follows the camera; waves are sampled in world space.
  const world = positionGeometry.xz.add(cameraPosition.xz);
  const distance = positionGeometry.xz.length();

  // 0 in the root, 1 past it: the open sea.
  const openAt = (xz) =>
    smoothstep(
      (rootSize / 2) * (1 - OPEN_OVER),
      rootSize / 2,
      max(abs(xz.x), abs(xz.y))
    );

  const depthAt = (xz) => {
    const v = texture(water, xz.div(rootSize).add(0.5)).r;

    return mix((sqrtEncoded ? v.mul(v) : v).mul(maxDepth), DEEP, openAt(xz));
  };

  // Waves shoal and die in shallow water.
  const shoaling = smoothstep(0.3, 10, depthAt(world));

  // How built-up the sea is here, against the open sea. The longest
  // cascade is the open sea's: the wind's lee doesn't calm it, but land in
  // its way does (./shelterMap.ts). The cascades after it are the wind's
  // (./seaWind.ts). Worked out per vertex and passed down.
  const gusting = !switchedOff("seawind");
  const sheltering = !switchedOff("shelter");

  const windy = gusting ? seaWindiness(world, rootSize) : null;

  const open = openAt(world);

  // (open sea, 89 m cascade, 13 m cascade, share whitecapped)
  const local: any = varying(
    mix(
      vec4(
        sheltering ? seaStanding(world, rootSize) : float(1),
        windy ? windy.built : vec2(1),
        windy ? windy.whitecaps : float(0)
      ),
      vec4(1, 1, 1, windy ? openWhitecaps() : float(0)),
      open
    )
  );

  // The wind here, m/s.
  const breeze: any = varying(
    windy ? mix(windy.speed, openWind.length(), open) : openWind.length()
  );

  const builtUp = (c: number) =>
    c === 0 ? local.x : c === 1 ? local.y : local.z;

  // The land's drawn this much taller than it is (../terrain/Terrain.tsx),
  // and its sea with it: the waves' rise, and so their slopes.
  const rise = vec3(1, verticalScale, 1);

  let displacement: any = vec3(0);
  cascades.forEach(({ size }, c) => {
    // Vertex density falls with distance, so drop each cascade once its
    // waves are smaller than the mesh can carry.
    const fade = float(1).sub(smoothstep(size * 4, size * 16, distance));
    displacement = displacement.add(
      texture(displacements[c], world.div(size))
        .level(float(0))
        .xyz.mul(fade)
        .mul(builtUp(c))
        .mul(rise)
    );
  });

  // The vertex's rise, for the shore foam. Passed down: used as is in the
  // fragment stage, each pixel would sample the three cascades again.
  const heave: any = varying(displacement.y);

  const material = new MeshBasicNodeMaterial({ transparent: true });

  // Its own haze, below: the scene's fog fades everything out at the
  // terrain's edge, which the sea runs on past.
  material.fog = false;

  // Past the root it's over the Earth's curve, as the far land is.
  material.positionNode = vec3(
    world.x,
    seaLevel.sub(earthDrop(world, rootSize)),
    world.y
  ).add(displacement.mul(shoaling));

  // How much of the far sea shows, by the far land's air (where it is on a
  // flat Earth), and none of it by the mesh's rim. All of what that air
  // lets through: the land's held to a faint shape, however clear the day,
  // and seen from high up that's the grey of the sea round it. The sea's
  // left the darker, as it is by the nearer land.
  const far: any = varying(
    clearTo(vec3(world.x, seaLevel, world.y)).mul(
      smoothstep(FAR_RADIUS, FAR_RADIUS * (1 - RIM), distance)
    )
  );

  // Fragment: positionGeometry is interpolated, so this is the undisplaced
  // point the vertex sampled from.
  const surface = positionGeometry.xz.add(cameraPosition.xz);
  const depth = depthAt(surface);
  const shallow = smoothstep(0.3, 10, depth);

  // How far gone the map is here, toward the root's edge and past it.
  const gone = edgeFade(surface, rootSize);

  // Metres of sea a pixel spans, the long way.
  const footprint = max(dFdx(surface).length(), dFdy(surface).length());

  let slope: any = vec2(0);
  let jacobian: any = float(1);
  // How far the jacobian strays here, squared, and how far below the
  // 89 m cascade's waves the pixel is: by then its whitecaps are too.
  let folds: any = float(0);
  let blurred: any = float(0);
  // Slope too fine to draw: what the mips have averaged out of the normal.
  let unseen: any = float(0);
  // The same for the mirror, with the ripples in: what roughens it.
  let rough: any = float(0);
  cascades.forEach(({ size }, c) => {
    // (slope x, slope z, jacobian, slope squared)
    const d = texture(derivatives[c], surface.div(size));
    const scale = builtUp(c);
    slope = slope.add(d.xy.mul(scale));

    // The squares' mean less the mean's square. Only where the map's
    // minified: between two texels the same sum is the slope's change
    // across them, which is drawn.
    const minified = log2(footprint.div(size / fftSize)).saturate();

    const hidden = max(d.w.sub(d.xy.dot(d.xy)), 0)
      .mul(scale.mul(scale))
      .mul(minified);

    rough = rough.add(hidden);

    // The finest cascade's ripples are under a pixel from any height, and
    // the glint's never counted them: the look is of the two that draw.
    if (c >= 2) return;

    jacobian = jacobian.add(d.z.sub(1).mul(scale));
    folds = folds.add((c === 0 ? folding.x : folding.y).mul(scale).pow(2));
    unseen = unseen.add(hidden);

    if (c === 1) blurred = minified;
  });
  const steeper = verticalScale.mul(verticalScale);
  slope = slope.mul(shallow).mul(verticalScale);
  unseen = unseen.mul(shallow).mul(shallow).mul(steeper);
  // The spectrum's ripples hardly still with the wind (its tail's as rough
  // at half a metre a second as at five), but a sea in a breath of wind is
  // glassy: it mirrors the hills until the wind picks up past a metre a
  // second or so, and has lost them by a fresh breeze.
  rough = rough
    .mul(shallow)
    .mul(shallow)
    .mul(steeper)
    .mul(smoothstep(GLASSY, RUFFLED, breeze));

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

  // Left out of the material, the mirror isn't rendered.
  const sky = switchedOff("reflection")
    ? vec3(0.04)
    : switchedOff("searough")
      ? roughMirrorBefore(mirror, slope)
      : roughMirror(mirror, slope, rough, view);

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

  // Whitecaps where the surface folds over (jacobian drops below 1), and
  // the wind's: where it squeezes most, as much of the sea as the wind
  // there whitecaps (./seaWind.ts). The drawn waves' squeeze barely grows
  // with the wind, so at a fixed squeeze a gale had no more than a breeze,
  // and a windy harbour none. Too far off to draw, their share of the sea.
  const capped = local.w;

  const squeezed = float(1)
    .sub(jacobian)
    .div(max(sqrt(folds), 1e-3));

  const threshold = belowShare(capped);

  const windCaps = mix(
    smoothstep(threshold.sub(0.3), threshold.add(0.3), squeezed),
    capped,
    blurred
  );

  const whitecaps = max(
    smoothstep(0.85, 0.35, jacobian),
    switchedOff("whitecaps") ? float(0) : windCaps
  ).mul(shallow);

  // Water thickness along the view ray, from the scene depth behind it.
  const thickness = viewportLinearDepth
    .sub(linearDepth())
    .mul(cameraFar.sub(cameraNear));

  // A continuous band that swells and recedes with the waves. Not past
  // the map: there's only the far land's coast behind the water there, too
  // far off for the depth to tell how much water's over it.
  const shoreFoam = float(1)
    .sub(smoothstep(0, 1.2, thickness))
    .mul(mix(0.45, 1, smoothstep(-0.3, 0.6, heave.add(slope.x.mul(2)))))
    .mul(float(1).sub(gone));

  const foam = max(whitecaps, shoreFoam.mul(0.8));

  // Held back a little: a full-strength mirror reads as glass, not sea.
  // And past the map more: seen from a height it's the horizon's haze the
  // far sea mirrors, which is about the far land's grey, and the land was
  // lost in it. This keeps the sea the darker of the two, as it is by the
  // nearer land.
  const reflection = sky.mul(mix(0.85, 1, lit));

  const color = mix(
    scatter,
    reflection,
    fresnel.mul(mix(MIRROR, FAR_MIRROR, gone))
  ).add(glint);

  const sea = mix(color, vec3(irradiance.mul(0.5)), foam).add(
    quakeGlow(surface)
  );

  // The haze, as the scene's fog has it on everything else (see Atmosphere
  // in ../WellingtonScene.tsx), but where that fades the map out toward
  // the root's edge, the sea goes over to the far land's thinner air and
  // carries on to it: all but toward the land out there that nothing
  // draws, where it's lost in the haze as before.
  const seen = mix(
    hazeTransmittance(cameraPosition, positionWorld),
    far.mul(openSea(coast, surface)),
    gone
  );

  const hazed = hazeColor(positionWorld.sub(cameraPosition), varying).add(
    hazeGlowAtNight(cameraPosition, positionWorld, "surface")
  );

  material.colorNode = mix(
    sea,
    hazed,
    float(1).sub(seen).mul(outsideClearing(positionWorld))
  );

  // See the sea floor through the shallows.
  // Slightly clear: the floor shows through the first few metres.
  material.opacityNode = mix(
    max(float(1).sub(exp(thickness.mul(-0.25))), foam),
    1,
    gone
  );

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
  const coast = useLoader(TextureLoader, COAST_URL);

  const { simulation, mesh, mirror } = useMemo(() => {
    for (const map of [water, coast]) {
      map.colorSpace = NoColorSpace;
      // Row 0 is the northern edge, matching world -z.
      map.flipY = false;
      map.minFilter = map.magFilter = LinearFilter;
      map.generateMipmaps = false;
    }

    // The simulation needs compute shaders writing storage textures, which
    // the WebGL 2 fallback can't do.
    const simulation = supported
      ? new OceanSimulation(quality.fftSize, createCascades(CASCADE_SIZES))
      : null;

    const { material, mirror } = createMaterial(
      simulation,
      water,
      coast,
      index,
      quality
    );

    const mesh = new Mesh(createSurfaceGeometry(quality.segments), material);
    mirror.reflector.getVirtualCamera(camera).layers.set(REFLECTION_LAYER);
    mesh.frustumCulled = false;
    // After the terrain, so the depth behind the water is known.
    mesh.renderOrder = 1;

    return { simulation, mesh, mirror };
  }, [index, quality, water, coast, supported, camera]);

  useEffect(() => {
    const { maxDepth = 30, encoding } = index.manifest.water ?? {};

    readDepths(water.image, index.manifest.rootSize, (byte) => {
      const v = byte / 255;

      return (encoding === "sqrt" ? v * v : v) * maxDepth;
    });
  }, [water, index]);

  useEffect(() => {
    const sea = simulation?.setConditions(conditions);

    // A sea that's measured has come from elsewhere; the wind's own grows
    // back past the land, over its fetch.
    if (sea) {
      setIncoming({
        open: sea.open,
        from: sea.from,
        length: sea.length,
        grows: conditions.sea ? undefined : conditions.fetch,
      });
    }

    const [x, z] = windVector(conditions.windSpeed, conditions.windDirection);
    openWind.value.set(x, z);
  }, [simulation, conditions]);

  useEffect(() => {
    if (supported && !switchedOff("seawind")) {
      loadSeaWind().catch((e) => console.error("[sea wind]", e));
    }
  }, [supported]);

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
