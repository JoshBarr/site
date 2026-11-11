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
  overcastFor,
  skyBrightness,
  skyHorizon,
  skyZenith,
} from "../environment";
import {
  airPhase as airPhaseOf,
  BEARINGS,
  CHANNELS,
  ELEVATIONS,
  HAZE_FORWARD,
  hazePhase as hazePhaseOf,
  skyLight,
  type SkyLight,
} from "./atmosphere";

// The scene's daylight from one model of the sky (./atmosphere.ts), in
// place of constants balanced by hand: how bright the sky is in each
// direction, how strong the sun is through the air, how much the sky lights
// the ground, and what the haze glows with. It came in a stage at a time,
// each on top of the last, judged against the sheets, and ?sky=0..3 still
// goes back to each (0 is the scene as it was before the model):
//
//   1  the sky drawn behind everything
//   2  the sun's strength
//   3  the sky's light on the ground and the clouds
//   4  the haze's glow
//
// The model's numbers are shares of the sun above the air. The scene's are
// what the camera makes of them: it opens up as the light goes, so they're
// scaled by an exposure that follows the light, part of the way.

/** How far the model lights the scene: all the way, unless the page says. */
const STAGES = 4;

/** The stage the scene's at: 0 is as it was before the model. */
export const skyStage = (() => {
  let stage: number | null = null;

  return () => {
    if (stage === null) {
      const params = new URLSearchParams(globalThis.location?.search ?? "");
      const asked = Number(params.get("sky"));

      stage =
        params.has("sky") && Number.isFinite(asked)
          ? Math.min(Math.max(asked, 0), STAGES)
          : STAGES;
    }

    return stage;
  };
})();

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
 * Of the glow the model gives the haze, how much is drawn. All of it is the
 * bright veil a camera sees, the far shore lost in it on a wet day. The scene
 * was balanced with a darker haze, which the city reads through: at a half,
 * the haze side-on to the reference sun is as bright as that was (0.095 of
 * the model's 0.197), and the model has the say over how it changes from
 * there. ?veil= tries another.
 */
const VEIL = 0.5;

const hazeVeil = (() => {
  let veil: number | null = null;

  return () => {
    if (veil === null) {
      const params = new URLSearchParams(globalThis.location?.search ?? "");
      const asked = Number(params.get("veil"));

      veil = params.has("veil") && asked >= 0 && asked <= 2 ? asked : VEIL;
    }

    return veil;
  };
})();

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
 * ground under it), as the scene's light.
 */
const around = uniform(0);

/** Of the sun, what gets through the cloud to light the air under it. */
const sunlit = uniform(1);

/**
 * Under a full deck the sun's a seventh of itself (see Sun), and the even
 * light nearly twice a clear sky's: the deck adds 0.9 to the sky's light on
 * the ground (skylightFor), and takes away the sunlight the ground sent
 * back up.
 */
const DECK_SUN = 0.85;
const DECK_GLOW = 0.9;

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

/** The haze's (Henyey-Greenstein), as ./atmosphere.ts has it. */
const hazePhase = (cosine) =>
  float(1 - HAZE_FORWARD ** 2).div(
    pow(
      float(1 + HAZE_FORWARD ** 2).sub(cosine.mul(2 * HAZE_FORWARD)),
      1.5
    ).mul(4 * Math.PI)
  );

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
  const drawn = level ? hazeVeil() : 1;

  return {
    sun: scattered.r
      .mul(airPhase(cosine))
      .add(scattered.g.mul(hazePhase(cosine)))
      .mul(daylight.mul(sunlit))
      .mul(drawn),
    even: scattered.b.mul(around).mul(drawn),
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

/** Of hazeRadiance, the sun's own light: what a shadow takes away. */
export const hazeSunRadiance = (direction) => towards(direction, true).sun;

/**
 * The sky's light on a cloud, from `height` 0 at its base to 1 at its top:
 * the old greys, or from stage 3 the model's sky by day and what's left of
 * the greys by night.
 */
export function skyOnCloud(height, greys = 1.4) {
  const grey = mix(skyHorizon, skyZenith.mul(3), height).mul(greys);

  return skyStage() >= 3
    ? grey.mul(nightSky).add(skyMean.mul(CLOUD_SKY))
    : grey.mul(skyBrightness);
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
}

let reference: { sun: number; level: number } | null = null;

/** The light on level ground, sun and sky, as shares of the sun above the air. */
const levelLight = (light: SkyLight, altitude: number) =>
  light.sun * Math.max(Math.sin((altitude * Math.PI) / 180), 0) + light.sky;

/**
 * The model's sky with the sun `altitude` degrees up, through haze of
 * extinction `haze` a metre at sea level thinning over `hazeHeight` m, as the
 * scene's light.
 */
export function skyFor(
  altitude: number,
  haze: number,
  hazeHeight: number
): Sky {
  if (!reference) {
    const light = skyLight(REFERENCE.altitude, REFERENCE);

    reference = {
      sun: light.sun,
      level: levelLight(light, REFERENCE.altitude),
    };
  }

  const light = skyLight(altitude, { haze, hazeHeight });
  const level = Math.max(levelLight(light, altitude), 1e-9);

  const exposure = Math.min(
    Math.pow(reference.level / level, ADAPTATION),
    MAX_EXPOSURE
  );

  const scale = (REFERENCE_SUN / reference.sun) * exposure;

  return { light, sun: light.sun * scale, sky: light.sky * scale, scale };
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
  sunlit.value = 1 - DECK_SUN * deck;
  around.value = light.around * scale * day * (1 + DECK_GLOW * deck);
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
  // the sky's too, low down the way the camera faces.
  return (
    (read(0) * airPhaseOf(toSun) + read(1) * hazePhaseOf(toSun)) *
      daylight.value *
      sunlit.value +
    read(2) * around.value
  );
}

let metered = false;

/**
 * Meters the frame for a camera facing `forward` (a unit vector), `delta`
 * seconds after the last.
 */
export function meterSky(forward: Vector3, delta: number) {
  if (!skyStage()) return;

  const glow = glowToward(forward);
  const target = glow > KEY ? Math.pow(KEY / glow, STOP) : 1;

  // The first frame's there already.
  const ease = metered ? 1 - Math.exp(-delta / ADAPT_TIME) : 1;

  metered = true;
  stopDown.value += (target - stopDown.value) * ease;
}
