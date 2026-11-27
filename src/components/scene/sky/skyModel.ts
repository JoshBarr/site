import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  Vector2,
  Vector3,
} from "three/webgpu";
import {
  acos,
  asin,
  dot,
  float,
  mix,
  normalize,
  pow,
  texture,
  uniform,
  vec2,
} from "three/tsl";
import {
  type CloudOver,
  lightUnder,
  sunOnDeck,
  sunUnderCloud,
} from "../cloudLight";
import { overcast, overcastFor, skyHorizon, skyZenith } from "../environment";
import {
  airPhase as airPhaseOf,
  BEARINGS,
  CHANNELS,
  ELEVATIONS,
  GROUND,
  HAZE_FORWARD,
  HAZE_PEAK,
  HAZE_PEAK_SHARE,
  hazePeaked,
  hazePhaseBroad,
  skyLight,
  type SkyLight,
} from "./atmosphere";

// The scene's daylight from one model of the sky (./atmosphere.ts), in
// place of constants balanced by hand: how bright the sky is in each
// direction, how strong the sun is through the air, how much the sky lights
// the ground, and what the haze glows with. The night's not its: the sky's
// old greys are still what's drawn then.
//
// The model's numbers are shares of the sun above the air. The scene's are
// what the camera makes of them: it opens up as the light goes, so they're
// scaled by an exposure that follows the light, part of the way.

/**
 * The sun the scene's other numbers were balanced under: 60° up through air
 * you can see 30 km through. There the model's sun is the light's old
 * intensity, 3, and the exposure 1.
 */
const REFERENCE = { altitude: 60, haze: 3.912 / 30000, hazeHeight: 900 };
const REFERENCE_SUN = 3;

/**
 * How far the exposure follows the light: 0 not at all (a low sun a tenth
 * of noon's, dusk black), 1 all the way (every hour as bright as noon).
 */
const ADAPTATION = 0.8;

/** The most the camera opens up, deep into twilight. */
const MAX_EXPOSURE = 400;

/**
 * Of the glow the model gives the haze, how much is drawn: all of it. That's
 * the bright veil a camera sees, the far shore lost in it on a wet day, and
 * it's the far hills going pale that gives a fine day its depth.
 *
 * The one dial to turn if the scene is to be less milky again. Until
 * 2026-11-27 it was drawn down by hand where it glared: to 0.4 under cloud
 * (from 75% cover) and to 0.6 in thick air (10 km or less). With the light
 * under cloud worked out (../cloudLight.ts) the haze there is lit by less
 * to begin with, and all of it is drawn whatever the sky and the air, the
 * milkier and the truer picture.
 *
 * ?veil= holds it at another level, to try one.
 */
const VEIL = 1;

const askedVeil = (() => {
  let veil: number | null | undefined;

  return () => {
    if (veil === undefined) {
      const params = new URLSearchParams(globalThis.location?.search ?? "");
      const asked = Number(params.get("veil"));

      veil = params.has("veil") && asked >= 0 && asked <= 2 ? asked : null;
    }

    return veil;
  };
})();

/** How much of the haze's glow is drawn: VEIL, unless the page says. */
const veilFor = () => askedVeil() ?? VEIL;

/** Of the old sky's greys, what's left of them on a moonless night. */
const NIGHT_SKY = 0.2;

/** And what the moonlight (as the light's intensity) adds to them. */
const MOON_SKY = 0.5;

const pixels = new Uint16Array(BEARINGS * ELEVATIONS * CHANNELS);

const table = new DataTexture(
  pixels,
  BEARINGS,
  ELEVATIONS,
  RGBAFormat,
  HalfFloatType
);

Object.assign(table, {
  magFilter: LinearFilter,
  minFilter: LinearFilter,
  wrapS: ClampToEdgeWrapping,
  wrapT: ClampToEdgeWrapping,
  needsUpdate: true,
});

/** Of the sun, what the frame's metered by (see meterSky): set by showSky. */
let meterSun = 1;

/** Toward the sun itself, down or not (sunDirection is the moon's by night). */
const skySun = uniform(new Vector3(0, 1, 0));

/** Its bearing, as a unit vector on the ground. */
const skyBearing = uniform(new Vector2(1, 0));

/**
 * What the model's shares of the sun are scaled by to be the scene's light:
 * the sun above the air, the exposure, and the daylight's fading into night.
 */
const daylight = uniform(0);

/**
 * The even light the air's lit by besides the sun (the sky around it and the
 * ground under it), as the scene's light: up in the sky, and down under
 * the cloud, where the haze is.
 */
const aroundSky = uniform(0);
const aroundHaze = uniform(0);

/** Of the model's glow, how much the haze is drawn with: see veilFor. */
const veil = uniform(VEIL);

/**
 * Of the sky's light on it, what a cloud sends on to the eye: under what a
 * white wall would, the march's own light being scaled to the sun's alone.
 */
const CLOUD_SKY = 0.6;

/** The sky's radiance by day, averaged over the dome, as the scene's light. */
const skyMean = uniform(0);

/**
 * How much of the old sky's greys is still there under the model: the
 * night's, which the model has nothing to say about.
 */
export const nightSky = uniform(NIGHT_SKY);

/** The air's phase function, by the cosine of the angle from the sun. */
const airPhase = (cosine) =>
  cosine
    .mul(cosine)
    .add(1)
    .mul(3 / (16 * Math.PI));

/** Henyey-Greenstein's phase function, of forwardness g. */
const lobe = (cosine, g: number) =>
  float(1 - g ** 2).div(
    pow(float(1 + g ** 2).sub(cosine.mul(2 * g)), 1.5).mul(4 * Math.PI)
  );

/**
 * The haze's, as ./atmosphere.ts has it: `forward` its broad lobe's g, and
 * with it the narrow one.
 */
export const hazeLobes = (cosine, forward = HAZE_FORWARD) =>
  hazePeaked
    ? mix(lobe(cosine, forward), lobe(cosine, HAZE_PEAK), HAZE_PEAK_SHARE)
    : lobe(cosine, forward);

const hazePhase = (cosine) => hazeLobes(cosine);

/**
 * The model's light toward `direction` (a unit vector), or with `level` the
 * light along the horizon on its bearing: what's scattered of the sun's
 * light, and of the even light around.
 */
function towards(direction, level: boolean) {
  // Straight up has no bearing: any will do, the table's the same all round.
  const flat = normalize(direction.xz.add(vec2(1e-6, 0)));
  const round = acos(dot(flat, skyBearing).clamp(-1, 1)).div(Math.PI);

  const up = level
    ? float(0)
    : asin(direction.y.clamp(0, 1))
        .div(Math.PI / 2)
        .sqrt();

  // Rows and columns sit on the table's pixel centres. Level 0 outright:
  // it's read in loops, where a level can't be worked out.
  const scattered = texture(
    table,
    vec2(
      round
        .mul(BEARINGS - 1)
        .add(0.5)
        .div(BEARINGS),
      up
        .mul(ELEVATIONS - 1)
        .add(0.5)
        .div(ELEVATIONS)
    ),
    0
  );

  const cosine = dot(direction, skySun);
  // The haze's glow is the level light, drawn as far as the veil goes.
  const drawn = level ? veil : 1;
  const air = scattered.r.mul(airPhase(cosine));
  const haze = scattered.g.mul(hazePhase(cosine));
  const full = air.add(haze).mul(daylight).mul(drawn);

  // The haze is lit by what gets under the cloud (../cloudLight.ts): it
  // lies low, under the cloud's base. Looked up through, the air above the
  // cloud has all of the sun, and looked along (`level`), all that's seen
  // is under it.
  const sun = level
    ? full.mul(sunUnderCloud)
    : air.add(haze.mul(sunUnderCloud)).mul(daylight);

  return {
    sun,
    full,
    even: scattered.b.mul(level ? aroundHaze : aroundSky).mul(drawn),
  };
}

const both = ({ sun, even }: ReturnType<typeof towards>) => sun.add(even);

/** The sky's radiance toward `direction`, by day; below the horizon, its. */
export const skyRadiance = (direction) => both(towards(direction, false));

/**
 * What haze glows with along `direction`, by day: enough of it and it's the
 * sky at the horizon that way, but lit from the angle it's seen at.
 */
export const hazeRadiance = (direction) => both(towards(direction, true));

/**
 * What the sun's own light in it would be with the sun on all of the air
 * that way, no cloud over it: hazeRadiance has the share that gets under
 * the cloud (sunUnderCloud).
 */
export const hazeSunFull = (direction) => towards(direction, true).full;

/**
 * The sky's light on a cloud, from `height` 0 at its base to 1 at its top:
 * the model's sky by day and what's left of the old greys by night. The
 * model's is the same at every height, so `shade` is how much of it gets
 * down that far through the cloud (skyThrough).
 */
export function skyOnCloud(height, greys = 1.4, shade: any = 1) {
  const grey = mix(skyHorizon, skyZenith.mul(3), height).mul(greys);

  return grey.mul(nightSky).add(skyMean.mul(CLOUD_SKY).mul(shade));
}

/**
 * The sun's light on a deck's underside, where `shade` of what's on its top
 * gets down to: the same light its base sheds on the ground (lightUnder).
 */
export function sunThroughDeck(shade: any = 1) {
  return overcast.mul(sunOnDeck).mul(CLOUD_SKY).mul(shade);
}

/** The sky and its exposure for a moment: see skyFor. */
export interface Sky {
  light: SkyLight;
  /** The sun's light as the scene has it: a light's intensity. */
  sun: number;
  /** The sky's on level ground, the same way. */
  sky: number;
  /** What both were scaled by: the sun above the air, exposed. */
  scale: number;
  /** The sun's on level ground, with no cloud over it, the same way. */
  level: number;
  /** Of the sun's beam, the share that gets under the cloud (lightUnder). */
  beam: number;
  /** The even light on level ground under the cloud, the same way. */
  under: number;
}

let reference: { sun: number; level: number } | null = null;

/** The sun's light on level ground, as a share of the sun above the air. */
const sunLevel = (light: SkyLight, altitude: number) =>
  light.sun * Math.max(Math.sin((altitude * Math.PI) / 180), 0);

/**
 * The model's sky with the sun `altitude` degrees up, through haze of
 * extinction `haze` a metre at sea level thinning over `hazeHeight` m, as the
 * scene's light; and under `clouds` (the highest layer first), what's left
 * of it on the ground. The camera's exposed for the light on the ground,
 * under the cloud.
 */
export function skyFor(
  altitude: number,
  haze: number,
  hazeHeight: number,
  clouds: CloudOver[] = []
): Sky {
  if (!reference) {
    const light = skyLight(REFERENCE.altitude, REFERENCE);

    reference = {
      sun: light.sun,
      level: sunLevel(light, REFERENCE.altitude) + light.sky,
    };
  }

  const light = skyLight(altitude, { haze, hazeHeight });
  const beam = sunLevel(light, altitude);
  const below = lightUnder(clouds, beam, light.sky);

  const level = Math.max(below.beam * beam + below.diffuse, 1e-9);

  const exposure = Math.min(
    Math.pow(reference.level / level, ADAPTATION),
    MAX_EXPOSURE
  );

  const scale = (REFERENCE_SUN / reference.sun) * exposure;

  return {
    light,
    sun: light.sun * scale,
    sky: light.sky * scale,
    scale,
    level: beam * scale,
    beam: below.beam,
    under: below.diffuse * scale,
  };
}

/**
 * Shows `sky` in the nodes above: with the sun toward `direction`, `night`
 * (0 by day to 1) of the way into night, the `moonlight` (the light's
 * intensity while it's the moon's), and `cloudCover` of the sky clouded.
 */
export function showSky(
  sky: Sky,
  direction: [number, number, number],
  night: number,
  moonlight: number,
  cloudCover: number
) {
  const { light, scale } = sky;

  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = DataUtils.toHalfFloat(light.table[i]);
  }

  table.needsUpdate = true;

  const [x, y, z] = direction;
  const across = Math.hypot(x, z);

  skySun.value.set(x, y, z);

  if (across > 1e-6) skyBearing.value.set(x / across, z / across);

  const day = 1 - night;

  const deck = overcastFor(cloudCover);

  daylight.value = scale * day;
  veil.value = veilFor();

  // The camera's metered by the glow the way it faces, and through broken
  // cloud that's two things: the cloud, as bright toward the sun as ever,
  // and between it the haze, lit by what gets under (the gaps' share of the
  // sky, which is the beam's). Under a deck there's only what gets under. A
  // guess at a whole view from one direction, as the meter is: with the
  // haze's share alone a view at the sun through cloud whited out, and with
  // all of the sun it came out darker than it used to.
  const gaps = sky.beam;
  const broken = 1 - gaps + gaps * gaps;

  meterSun = broken + (gaps - broken) * deck;

  // The air under the cloud is lit as the ground there is: by the sky that
  // reaches it, and what the ground sends back up of all it gets.
  sunUnderCloud.value = sky.beam;
  sunOnDeck.value = (sky.level * day) / Math.PI;
  aroundSky.value = light.around * scale * day;

  aroundHaze.value =
    (((1 + GROUND) * sky.under + GROUND * sky.beam * sky.level) /
      (2 * Math.PI)) *
    day;

  skyMean.value = (sky.sky * day) / Math.PI;
  nightSky.value = NIGHT_SKY * night + MOON_SKY * moonlight;
}

// Toward a low sun the sky and the haze are many times brighter than
// anything under them, and a camera pointed that way stops down: the land
// goes to silhouette under a bright veil, where the frame would otherwise be
// white. The frame's metered by the glow at the horizon the way the camera
// faces, and scaled at the last, lights and all.

/** The haze's glow, as the scene's light, the frame's exposed for at most. */
const KEY = 0.4;

/** How far it stops down for more than that: 1 would hold the glow at KEY. */
const STOP = 0.8;

/** Seconds for it to settle most of the way, as the view turns. */
const ADAPT_TIME = 0.7;

/** What the finished frame's scaled by: 1 unless the haze ahead is bright. */
export const stopDown = uniform(1);

/** As `towards`, level, on the CPU: the haze's glow the way `forward` faces. */
function glowToward(forward: Vector3) {
  const bearing = skyBearing.value;
  const across = Math.hypot(forward.x, forward.z);

  const cosine =
    across > 1e-6
      ? (forward.x * bearing.x + forward.z * bearing.y) / across
      : 1;

  const column =
    (Math.acos(Math.min(Math.max(cosine, -1), 1)) / Math.PI) * (BEARINGS - 1);

  const i = Math.min(Math.floor(column), BEARINGS - 2);
  const t = column - i;

  // The table's first row, the horizon.
  const read = (channel: number) =>
    DataUtils.fromHalfFloat(pixels[i * CHANNELS + channel]) * (1 - t) +
    DataUtils.fromHalfFloat(pixels[(i + 1) * CHANNELS + channel]) * t;

  const toSun = forward.dot(skySun.value);

  // All of the model's glow, whatever of it the haze is drawn with: it's
  // the sky's too, low down the way the camera faces. Less the narrow lobe
  // round the sun: this is one direction standing for the whole view, and
  // facing the sun it stopped the frame down as though the view were all
  // that bright.
  return (
    (read(0) * airPhaseOf(toSun) + read(1) * hazePhaseBroad(toSun)) *
      daylight.value *
      meterSun +
    read(2) * aroundHaze.value
  );
}

let metered = false;

/**
 * Meters the frame for a camera facing `forward` (a unit vector), `delta`
 * seconds after the last.
 */
export function meterSky(forward: Vector3, delta: number) {
  const glow = glowToward(forward);
  const target = glow > KEY ? Math.pow(KEY / glow, STOP) : 1;

  // The first frame's there already.
  const ease = metered ? 1 - Math.exp(-delta / ADAPT_TIME) : 1;

  metered = true;
  stopDown.value += (target - stopDown.value) * ease;
}
