import { cameraPosition, dot, float, max, mix, smoothstep } from "three/tsl";
import * as environment from "../environment";
import {
  hazeColor,
  hazeGlowToward,
  hazeGrey,
  hazeTransmittance,
} from "../haze";
import { cloudLayers, skyThrough } from "../clouds/density";
import { hazeGlowAtNight } from "../skyglow";
import { switchedOff } from "../stats";
import { nightSky, skyOnCloud, skyRadiance, sunThroughDeck } from "./skyModel";

// The sky behind everything, by the direction it's seen in: what the scene's
// background draws (with the sun's disc and the moon over it), and what the
// land past the terrain's edge fades into.

/** Sky samples reach this far for the city's glow, m. */
const SKYGLOW_DISTANCE = 20000;

/** 1 at the horizon to 0 a quarter of the way up: where the sky's hazy. */
const lowDown = (direction) =>
  float(1).sub(smoothstep(0, 0.25, max(direction.y, 0)));

/**
 * Of the modelled sky along `direction`, how much is the haze's glow and
 * not the sky's own: all of it under the horizon, most of it low down.
 */
const hazedAlong = (direction) =>
  max(smoothstep(0, -0.02, direction.y), lowDown(direction).mul(0.8));

/**
 * The sky along `direction` (unit, world), less the sun's disc and the
 * moon: zenith to horizon, hazier toward the horizon, glowing toward the
 * sun. Under a deck it goes flat grey: the clouds hide it, but the water's
 * reflection (which leaves them out) shows it. At night the city lights it
 * from below.
 */
export function skyAlong(direction) {
  const toward = dot(direction, environment.sunDirection);

  const greys = mix(
    environment.skyHorizon,
    mix(environment.skyZenith, environment.skyHorizon, environment.overcast),
    smoothstep(0, 0.35, direction.y)
  );

  const horizon = lowDown(direction);

  const far = cameraPosition.add(direction.mul(SKYGLOW_DISTANCE));

  // The day's sky is the sky model's, hazy horizon, glow round the sun and
  // all, going over to the deck's underside as the cloud closes; the old
  // greys are what's left of the sky at night, and the glow the moon's.
  // Under the horizon there's no sky, only the haze the far sea's lost in.

  // The sky goes over to the haze toward the horizon: far cloud and far
  // hills fade into that, and a brighter sky behind them showed as a band
  // under the cloud.
  const hazed = hazedAlong(direction);

  // The deck's underside, lost in the haze toward the horizon: the open
  // sky's light on it as dim as the march has the low layer's base.
  const shade = switchedOff("cloudshade")
    ? float(1)
    : skyThrough(cloudLayers.low, 0).mul(skyThrough(cloudLayers.mid, 0));

  const haze = hazeColor(direction);

  const deck = mix(
    haze,
    skyOnCloud(0, 1.4, shade).add(
      sunThroughDeck(
        skyThrough(cloudLayers.low, 0).mul(skyThrough(cloudLayers.mid, 0))
      )
    ),
    hazeTransmittance(cameraPosition, far)
  );

  const air = mix(
    mix(skyRadiance(direction), deck, environment.overcast)
      .add(mix(greys, hazeGrey, horizon.mul(0.8)).mul(nightSky))
      .add(hazeGlowToward(toward, 0.15).mul(environment.moonlit)),
    haze,
    hazed
  );

  return air.add(
    hazeGlowAtNight(cameraPosition, far, "sky").mul(
      float(1).sub(hazeTransmittance(cameraPosition, far))
    )
  );
}
