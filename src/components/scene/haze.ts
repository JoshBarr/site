import { Color } from "three/webgpu";
import {
  abs,
  dot,
  exp,
  float,
  max,
  mix,
  normalize,
  pow,
  select,
  uniform,
} from "three/tsl";
import { skyHorizon, sunDirection, sunIntensity } from "./environment";

// Atmospheric haze: extinction falls off exponentially with height, so the
// boundary layer over the harbour is thick and the hilltops clear above it.

/** Extinction at sea level, per metre. Set from visibility. */
export const hazeDensity = uniform(1e-4);

/** Height over which haze thins by a factor of e, in metres. */
export const hazeHeight = uniform(900);

/** Colour of the haze lit from the side; the sun adds a glow toward itself. */
const hazeTint = uniform(new Color("#4a4a4a"));

/** Koschmieder: visibility is where contrast falls to 2% (ln 50 ≈ 3.912). */
export function hazeDensityForVisibility(visibility: number) {
  return 3.912 / Math.max(visibility, 200);
}

/** Optical depth of the haze along a straight path between two points. */
function hazeDepth(from, to) {
  const length = to.sub(from).length();
  const h0 = max(from.y, 0);
  const h1 = max(to.y, 0);
  // ∫ σ0·exp(-h/H) ds along the path, in closed form. k → 0 is a level path.
  const k = h1.sub(h0).div(hazeHeight);

  const ratio = select(
    abs(k).lessThan(1e-3),
    float(1).sub(k.mul(0.5)),
    float(1).sub(exp(k.negate())).div(k)
  );

  return hazeDensity
    .mul(length)
    .mul(exp(h0.negate().div(hazeHeight)))
    .mul(ratio);
}

/** Fraction of light from `to` that reaches `from` through the haze. */
export function hazeTransmittance(from, to) {
  return exp(hazeDepth(from, to).negate());
}

/** Henyey-Greenstein phase function. */
export function phase(cosine, g) {
  const g2 = g * g;

  return float(1 - g2).div(
    pow(float(1 + g2).sub(cosine.mul(2 * g)), 1.5).mul(4 * Math.PI)
  );
}

/**
 * Light the haze scatters toward the viewer along `direction`: the horizon
 * colour, brightened toward the sun by forward scattering.
 */
export function hazeColor(direction) {
  const toward = dot(normalize(direction), sunDirection);
  const glow = phase(toward, 0.7).mul(sunIntensity).mul(0.6);

  return mix(skyHorizon, hazeTint, 0.5).add(glow);
}
