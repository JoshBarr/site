import { abs, cameraPosition, dot, exp, max, pow, smoothstep } from "three/tsl";
import { hazeTransmittance } from "../haze";

// What's past the terrain's root (the South Island, and the sea out around
// it) is seen through a lot of air, over the Earth's curve: how far it's
// sunk by the one, and how much of it shows through the other.

/** The Earth's radius, m, and how much of its curve refraction undoes. */
const EARTH_RADIUS = 6371000;
const REFRACTION = 0.13;

/** What the Earth's surface sinks by, m, for the square of its distance, m². */
const CURVE = (1 - REFRACTION) / (2 * EARTH_RADIUS);

/**
 * The root's own ground is flat. Past its edge the curve comes in over this
 * far, m: by the Sounds' nearest shores it's nearly all there.
 */
const EASE = 8000;

/**
 * How far the Earth's surface at world `xz` is under the scene's flat one,
 * m, curving away from wherever the camera is: none in the terrain's root,
 * `rootSize` m a side, and past it the far ranges are hull down, more so
 * from the shore than from the hills. The far land and the sea around it
 * sink by the same, so its coasts stay where they are.
 */
export function earthDrop(xz, rootSize: number) {
  const away = xz.sub(cameraPosition.xz);
  const edge = max(abs(xz.x), abs(xz.y));

  return dot(away, away)
    .mul(CURVE)
    .mul(smoothstep(rootSize / 2, rootSize / 2 + EASE, edge));
}

/**
 * Of the haze's optical depth between the camera and what's out there, how
 * much counts. The scene's haze is thick, to give 60 km of ground some
 * depth: through all of it nothing 50 km off would show, on any day. Out
 * over the strait it's taken to be this much thinner.
 */
const THINNER = 0.25;

/**
 * And the air itself, haze or none, lets 1/e through for each this far, m:
 * about what clean air scatters between here and the ranges' tops, which
 * stand above the haze. Together, on a day you can see 30 km across the
 * harbour, the Sounds show at about a fifth of their contrast and the
 * Kaikōuras' tops likewise, their feet less; at 10 km none of it does.
 */
const AIR = 150000;

/**
 * How much of what's at `at` (world, where it is on a flat Earth, not where
 * the curve has it drawn: the air curves with the Earth) shows from the
 * camera, 0 to 1: the rest is the sky behind it.
 */
export function clearTo(at) {
  return pow(hazeTransmittance(cameraPosition, at), THINNER).mul(
    exp(at.distance(cameraPosition).div(-AIR))
  );
}
