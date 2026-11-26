import { useEffect, useMemo, useState } from "react";
import { BufferGeometry, Mesh, MeshBasicNodeMaterial } from "three/webgpu";
import {
  attribute,
  cameraPosition,
  dot,
  float,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  smoothstep,
  vec3,
} from "three/tsl";
import {
  cloudShadow,
  nearShadow,
  seaLevel,
  skyBrightness,
  skylight,
  skyZenith,
  sunDirection,
  sunIntensity,
  sunShadow,
} from "../environment";
import { hazeColor } from "../haze";
import {
  type CalmSea,
  MIRROR,
  MIRROR_SHADED,
  seaReflectance,
  sheen,
  sparkle,
  sunScatter,
} from "../ocean/calm";
import { verticalScale } from "../terrain/Terrain";

type WaterMesh = Mesh<BufferGeometry, MeshBasicNodeMaterial>;

export interface WaterLook {
  /** How much of the light on it the water sends back up out of it. */
  reflectance: number;
  /**
   * Water lies low: looking across it, its mirror holds the far bank and the
   * hills behind, not the sky, up to about this elevation (a sine).
   */
  banks: number;
  /**
   * Faded out by the geometry's `fade` attribute (0..1), over what it's
   * drawn after: the sea, which a river runs out into.
   */
  fades?: boolean;
  /**
   * The sea it runs out into (../ocean/calm.ts). Its water down at sea
   * level is the sea's: it rides the tide, and it's shaded as the sea is
   * there, so the two are one water where they meet, not one laid over the
   * other. Up from there it eases into its own look, by the geometry's
   * `level` attribute: the water's height, m above mean sea level.
   */
  sea?: CalmSea;
}

/**
 * Over the floor the lidar left (flattened to the water's surface), m, so
 * the floor doesn't show through.
 */
const LIFT = 0.15;

/**
 * Far off, the terrain's drawn from coarser tiles, whose averaged banks can
 * stand metres over the water. So it's drawn as if this share of its
 * distance nearer, up to PULL_MOST m: along the line of sight, so it stays
 * where it is on screen and only wins the depth test. Hills between hide
 * it still: they're hundreds of metres nearer.
 */
const PULL = 0.003;
const PULL_MOST = 60;

/**
 * Water running into the sea is the sea's up to this high, m above mean sea
 * level, and all its own from this: the Hutt's level is under the first for
 * its last two and a half kilometres (as the lidar found it), and over the
 * second four kilometres up.
 */
const TIDAL = 0.3;
const FRESH = 1.5;

/**
 * An estuary's this deep at least, m, for its colour: the sea's depth map
 * has none up a river, and its shallowest shelf is the palest water there
 * is.
 */
const ESTUARY = 1;

/**
 * Still water, shaded as the sea is when it's calm (../ocean/Ocean.tsx),
 * less its planar mirror, which is only true at sea level: the sky's in it
 * instead, the haze's colour low down to the zenith's overhead, and the
 * banks' dark below the look's `banks`. Its geometry's y is metres above sea
 * level, scaled here as the land is.
 */
function createWaterMaterial({
  reflectance,
  banks: hills,
  fades = false,
  sea,
}: WaterLook) {
  const material = new MeshBasicNodeMaterial({
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  const level = positionGeometry.y.mul(verticalScale);

  const surface = vec3(
    positionGeometry.x,
    // Never under the sea it runs into: its last reach comes up with the
    // tide.
    (sea ? max(level, seaLevel) : level).add(LIFT),
    positionGeometry.z
  );

  const toEye = cameraPosition.sub(surface);

  material.positionNode = surface.add(
    normalize(toEye).mul(min(toEye.length().mul(PULL), PULL_MOST))
  );

  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = max(view.y, 0);
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98));
  const reflected = vec3(view.x.negate(), view.y, view.z.negate());

  // SAFETY: shadow() makes a float node; see environment.ts.
  const lit = float(sunShadow as any)
    .mul(nearShadow as any)
    .mul(cloudShadow);

  // Lit like the land, as the sea is.
  const irradiance = sunIntensity
    .mul(3)
    .mul(max(sunDirection.y, 0))
    .mul(lit)
    .add(skylight)
    .div(Math.PI);

  const sky = mix(
    hazeColor(reflected),
    skyZenith.mul(skyBrightness),
    smoothstep(0.1, 0.8, reflected.y)
  );

  const banks = vec3(irradiance.mul(0.05));
  const mirror = mix(banks, sky, smoothstep(0, hills, reflected.y));

  // Still water's glint: tight, and a little soft for the ripples.
  const sunAmount = max(dot(reflected, sunDirection), 0);

  const glint = pow(sunAmount, 400)
    .mul(8)
    .add(pow(sunAmount, 40).mul(0.1))
    .mul(sunIntensity)
    .mul(lit)
    .mul(smoothstep(0, hills, reflected.y));

  const own = mix(
    vec3(irradiance.mul(reflectance)),
    mirror,
    fresnel.mul(MIRROR)
  ).add(glint);

  material.colorNode = sea
    ? mix(
        own,
        asTheSea(sea, { fresnel, irradiance, lit, sunAmount }),
        // By the water's level, not the ribbon's height: its banks are
        // lifted onto the terrain's coarse tiles, vertex by vertex.
        float(1).sub(
          smoothstep(TIDAL, FRESH, attribute<"float">("level", "float"))
        )
      )
    : own;

  if (fades) {
    material.transparent = true;
    material.opacityNode = attribute<"float">("fade", "float");
  }

  return material;
}

/**
 * A level, unruffled sea's colour here (../ocean/Ocean.tsx, less its waves,
 * its foam and the floor showing through its shallows): what it scatters
 * back out, by its depth; its mirror, which is true this near its level;
 * and its glint.
 */
function asTheSea(sea: CalmSea, { fresnel, irradiance, lit, sunAmount }) {
  // Where the water is, not where it's drawn (pulled toward the eye).
  const depth = max(sea.depthAt(positionGeometry.xz), ESTUARY);

  const scatter = vec3(seaReflectance(depth).mul(irradiance)).add(
    sunScatter(max(sunDirection.y, 0)).mul(sunIntensity).mul(lit)
  );

  return mix(
    scatter,
    sea.mirrored.mul(mix(MIRROR_SHADED, 1, lit)),
    fresnel.mul(MIRROR)
  ).add(sparkle(sunAmount).add(sheen(sunAmount)).mul(sunIntensity).mul(lit));
}

/**
 * The water a built file describes, once it's loaded: `build` makes its
 * geometry, `look` its material (see createWaterMaterial). With no look
 * yet (a river's waits for the sea's), none's made.
 */
export function useWaterMesh<T>(
  url: string,
  build: (file: T) => BufferGeometry,
  look: WaterLook | null
) {
  const [file, setFile] = useState<T | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);

        return response.json();
      })
      .then((loaded) => {
        if (cancelled) return;

        // SAFETY: the caller names the file's type, and the build scripts
        // that write it are deployed with the app.
        setFile(loaded as T);
      })
      .catch((e) => console.error("[water]", e));

    return () => {
      cancelled = true;
    };
  }, [url]);

  const mesh = useMemo(() => {
    if (!file || !look) return null;

    const built: WaterMesh = new Mesh(build(file), createWaterMaterial(look));

    // Its y is scaled in the shader; the sphere's isn't.
    built.frustumCulled = false;
    // After the terrain, as the sea is; one that fades, after the sea.
    built.renderOrder = look.fades ? 2 : 1;

    return built;
  }, [file, build, look]);

  useEffect(
    () => () => {
      mesh?.geometry.dispose();
      mesh?.material.dispose();
    },
    [mesh]
  );

  return mesh;
}
