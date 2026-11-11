import { useFrame } from "@react-three/fiber";
import { Matrix3, Vector3 } from "three/webgpu";
import {
  cameraPosition,
  dot,
  exp,
  float,
  Fn,
  If,
  normalize,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { overcast } from "../environment";
import { hazeTransmittance } from "../haze";
import { devicePixelAngle } from "../landmarks/common";
import {
  moon,
  moonDirection as moonDirectionAt,
  skyRotation,
} from "./ephemeris";
import { sceneNow } from "../clock";
import type { Moon } from "./ephemeris";

// The Moon: a disc in the sky, lit from where the Sun really is, so it
// waxes and wanes, with its seas on it; and, while the Sun's down, the
// light the scene's lit by (see the Sun in WellingtonScene).

/**
 * Its angular radius, radians: twice its real 0.26°, as the sun's disc is.
 * True to size it was a speck a few pixels across, where the eye (and a
 * camera's long lens) makes a low Moon look far bigger.
 */
const RADIUS = 0.52 * (Math.PI / 180);

/**
 * How bright the lit disc is: at night as white as the frame goes, its seas
 * grey on it (any brighter and they'd clip to white too); by day only a pale
 * shape against the sky.
 */
const NIGHT_RADIANCE = 1;
const DAY_RADIANCE = 0.12;

/** Of the lit side's, the earthshine on the dark side. */
const EARTHSHINE = 0.012;

/** The disc's haze is reckoned this far along the line of sight, m. */
const HAZE_REACH = 20_000;

/**
 * Light from a full Moon high up, as the scene's directional light's
 * intensity (the Sun's is 3).
 */
const FULL_MOON_LIGHT = 0.35;

/**
 * Its seas as seen from the Earth, north up and selenographic east (Mare
 * Crisium's side) to the right: centre on the disc (radius 1), size and
 * how much darker. Rough shapes, to read as the Moon at a few pixels across.
 */
const MARIA: [number, number, number, number][] = [
  [-0.55, 0.15, 0.4, 0.45], // Oceanus Procellarum
  [-0.25, 0.5, 0.28, 0.5], // Imbrium
  [0.3, 0.45, 0.17, 0.5], // Serenitatis
  [0.42, 0.14, 0.2, 0.5], // Tranquillitatis
  [0.72, 0.32, 0.12, 0.55], // Crisium
  [0.62, -0.12, 0.14, 0.4], // Fecunditatis
  [0.28, -0.28, 0.13, 0.35], // Nectaris
  [-0.15, -0.35, 0.18, 0.35], // Nubium
  [-0.45, -0.45, 0.12, 0.3], // Humorum
];

/** Unit vector toward the Moon from the viewer (x east, y up, z south). */
const moonDirection = uniform(new Vector3(0, -1, 0));

/** Toward the Sun from the Moon: near enough, from the Earth. */
const sunward = uniform(new Vector3(0, -1, 0));

/** The Moon's north pole, as a direction in the scene. */
const north = uniform(new Vector3(0, 1, 0));

/** The lit disc's radiance; 0 draws no Moon at all. */
const radiance = uniform(0);

/** The ecliptic's north pole, equatorial: near enough the Moon's axis. */
const OBLIQUITY = 23.43928 * (Math.PI / 180);
const ECLIPTIC_POLE = new Vector3(0, -Math.sin(OBLIQUITY), Math.cos(OBLIQUITY));

const turn = new Matrix3();

/**
 * Keeps the disc where the Moon is, at the scene's time, every frame (the
 * sky turns 0.08° between clock ticks), lit by the Sun at `sun` and as
 * bright as `night` (0 day to 1 night) says.
 */
export function useMoon(sun: [number, number, number], night: number) {
  useFrame(() => {
    const now = sceneNow();

    moonDirection.value.set(...moonDirectionAt(now));
    north.value.copy(ECLIPTIC_POLE).applyMatrix3(skyRotation(now, turn));
    sunward.value.set(...sun);
    radiance.value = DAY_RADIANCE + (NIGHT_RADIANCE - DAY_RADIANCE) * night;
  });
}

/** Stops drawing the disc (the sky's switched off). */
export function hideMoon() {
  radiance.value = 0;
}

/**
 * The Moon's light along `direction` (unit, world): its disc, waxing or
 * waning, with its seas and the earthshine, dimmed by the haze and hidden
 * by a deck. Black away from it, and skipped there.
 */
export const moonDisc = (direction) =>
  Fn(() => {
    const light = vec3(0).toVar();
    const toward = dot(direction, moonDirection);

    If(
      toward.greaterThan(Math.cos(RADIUS * 1.5)).and(radiance.greaterThan(0)),
      () => {
        // Where on the disc, -1..1 each way, north up.
        const up = normalize(
          north.sub(moonDirection.mul(dot(north, moonDirection)))
        );

        const right = moonDirection.cross(up);
        const offset = direction.sub(moonDirection.mul(toward));

        const at = vec2(dot(offset, right), dot(offset, up)).div(
          Math.sin(RADIUS)
        );

        const r = at.length();

        // The face toward the viewer, as a sphere: lit where it faces the Sun.
        const normal = vec3(at, sqrt(float(1).sub(r.mul(r)).max(0)));

        const facing = dot(
          normal,
          vec3(
            dot(sunward, right),
            dot(sunward, up),
            dot(sunward, moonDirection).negate()
          )
        );

        const lit = smoothstep(-0.04, 0.06, facing);

        let albedo: any = float(1);

        for (const [x, y, size, dark] of MARIA) {
          const d = at.sub(vec2(x, y));

          albedo = albedo.sub(exp(dot(d, d).div(-size * size)).mul(dark));
        }

        // A pixel's softening at the limb, wherever the camera's zoomed.
        const edge = float(1)
          .sub(r)
          .mul(Math.sin(RADIUS))
          .div(devicePixelAngle)
          .add(0.5)
          .clamp(0, 1);

        const far = direction.mul(HAZE_REACH);

        light.assign(
          vec3(
            albedo
              .clamp(0.4, 1)
              .mul(lit.add(EARTHSHINE))
              .mul(edge)
              .mul(radiance)
              .mul(float(1).sub(overcast))
              .mul(hazeTransmittance(cameraPosition, cameraPosition.add(far)))
          )
        );
      }
    );

    return light;
  })();

/**
 * The scene's light from the Moon, as the directional light's intensity:
 * by its phase (the flux, square-rooted, as eyes adjust: a half Moon gives
 * a third of the full's light, not a tenth), fading in over its first few
 * degrees up, and only once the Sun's down.
 */
export function moonlight(
  { magnitude }: Moon,
  altitude: number,
  sunAltitude: number
) {
  const flux = 10 ** (-0.4 * (magnitude + 12.73));
  const up = Math.min(Math.max(altitude / 6, 0), 1);
  const dark = Math.min(Math.max(-sunAltitude / 6, 0), 1);

  return FULL_MOON_LIGHT * Math.sqrt(flux) * up * dark * dark * (3 - 2 * dark);
}

/** The Moon at `time`, and where it is in the scene. */
export function moonAt(time: number) {
  const body = moon(time);
  const direction = moonDirectionAt(time, body);

  return {
    body,
    direction,
    altitude: Math.asin(direction[1]) * (180 / Math.PI),
  };
}
