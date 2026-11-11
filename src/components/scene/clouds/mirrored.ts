import {
  Fn,
  If,
  cameraPosition,
  float,
  max,
  min,
  mix,
  smoothstep,
  vec3,
} from "three/tsl";
import { overcast, seaLevel, sunIntensity } from "../environment";
import { hazeColor, hazeTransmittance } from "../haze";
import { skyOnCloud } from "../sky/skyModel";
import { cloudGlowAtNight } from "../skyglow";
import { cloudShare } from "./cloudField";
import { coverageMap, LOW_ANGLE } from "./coverage";
import { cloudLayers, cloudNoise, deckLid, saturate } from "./density";

// The clouds are a pass over the finished frame, so the sea's mirror (a
// render of the scene from under the water) never had them in it: under
// broken cloud the harbour reflected a plain gradient. The sky the mirror
// sees gets the low layer's cover instead, read where its ray meets the
// layer's base: soft shapes where the real ones are, drifting with them.
// In the sky, not the water, so reflected hills still hide it.

/**
 * The underside's light, of the sun's: what gets through a cloud's body and
 * out its base. Matched to the undersides the march draws at noon (about
 * 0.2 before tone mapping); the mirror's clear sky is far darker than the
 * sky seen, which the haze in the cloud pass lights.
 */
const UNDERSIDE_SUN = 0.2;

/** Past this along the ray, m, the base is too far off to show. */
const REACH = 40000;

/** The mirror's camera is the main one turned under the sea. */
const inMirror = cameraPosition.y.lessThan(seaLevel);

/**
 * `sky`, the background toward `direction` (haze and all), with the low
 * cloud's base over it, for the mirror's camera only. Under a deck it's left alone: the sky's
 * already the deck's flat grey there.
 */
export const withMirroredCloud = (sky, direction) =>
  Fn(() => {
    const shown = vec3(sky).toVar();
    const { low } = cloudLayers;
    const clouded = low.shape.z.greaterThan(0).or(deckLid.greaterThan(0));

    If(inMirror.and(direction.y.greaterThan(0.01)).and(clouded), () => {
      const t = low.shape.x.sub(cameraPosition.y).div(direction.y);
      const xz = cameraPosition.xz.add(direction.xz.mul(t));

      const { map } = coverageMap(
        cloudNoise.weather,
        xz,
        low.offset,
        LOW_ANGLE
      );

      // As the march's layers have it (density.ts): the cover shared out to
      // where the satellite saw cloud, its regions, and the deck's lid.
      const share = cloudShare(xz);
      const coverage = min(low.shape.z.mul(share), 1);

      const region = smoothstep(
        float(1).sub(coverage).sub(0.12),
        float(1).sub(coverage).add(0.12),
        map
      ).mul(saturate(coverage.mul(20)));

      const cloud = max(region, deckLid.mul(min(share, 1)))
        .mul(smoothstep(REACH, REACH * 0.5, t))
        .mul(float(1).sub(overcast));

      const underside = skyOnCloud(0)
        .add(overcast.mul(sunIntensity).mul(1.2))
        .add(sunIntensity.mul(UNDERSIDE_SUN))
        .add(cloudGlowAtNight(vec3(xz.x, low.shape.x, xz.y)));

      // Seen through the haze between: from the camera above the water,
      // the mirror's own being under it, to the base.
      const base = vec3(xz.x, low.shape.x, xz.y);

      const above = vec3(
        cameraPosition.x,
        seaLevel.mul(2).sub(cameraPosition.y),
        cameraPosition.z
      );

      const seen = mix(
        hazeColor(direction),
        underside,
        hazeTransmittance(above, base)
      );

      shown.assign(mix(shown, seen, cloud));
    });

    return shown;
  })();
