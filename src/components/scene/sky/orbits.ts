import {
  ecfToLookAngles,
  eciToEcf,
  gstime,
  json2satrec,
  jday,
  propagate,
  type SatRec,
  shadowFraction,
  sunPos,
} from "satellite.js";
import type { Orbit } from "../../../lib/satellites";
import { WELLINGTON } from "../sun";

// Satellites seen from Wellington: SGP4 from CelesTrak's mean elements (by
// satellite.js), then where each is in the scene's sky and how bright,
// dimmed to nothing in the Earth's shadow.

const RAD = Math.PI / 180;

const OBSERVER = {
  latitude: WELLINGTON.latitude * RAD,
  longitude: WELLINGTON.longitude * RAD,
  height: 0,
};

/**
 * Standard magnitude: at 1,000 km, half lit. Known for a few (Heavens-Above
 * and McCants' lists, near enough); the rest of the visual group are the
 * brighter rocket bodies and satellites, so a guess between.
 */
const STANDARD = new Map([
  // ISS
  [25544, -1.3],
  // Tiangong (Tianhe), a guess: around half the ISS's size.
  [48274, -0.3],
  // Hubble
  [20580, 2.2],
]);

/** AST SpaceMobile's BlueBirds: 64 m² arrays, about first magnitude. */
const BLUEBIRD = 1;

const OTHERS = 3.5;

export interface Satellite {
  id: number;
  name: string;
  record: SatRec;
  /** Standard magnitude. */
  standard: number;
}

/** Ready to run: those SGP4 can't start from are left out. */
export function satellitesFrom(orbits: Orbit[]): Satellite[] {
  return orbits.flatMap((orbit) => {
    const record = json2satrec(orbit);

    if (record.error) return [];

    return [
      {
        id: orbit.NORAD_CAT_ID,
        name: orbit.OBJECT_NAME,
        record,
        standard:
          STANDARD.get(orbit.NORAD_CAT_ID) ??
          (orbit.OBJECT_NAME.startsWith("SPACEMOBILE") ? BLUEBIRD : OTHERS),
      },
    ];
  });
}

export interface Sighting {
  /** Unit vector toward it, scene frame (x east, y up, z south). */
  direction: [number, number, number];
  /** Degrees above the horizon. */
  elevation: number;
  /** As it looks: 10 or more fainter in the Earth's shadow. */
  magnitude: number;
  /** In the Earth's shadow: 0 sunlit, 1 in the umbra. */
  shade: number;
  /** How far off, km. */
  range: number;
}

/** Where `satellite` is in Wellington's sky at `time` (epoch ms); null if SGP4 fails. */
export function sight(satellite: Satellite, time: number): Sighting | null {
  const date = new Date(time);
  const state = propagate(satellite.record, date);

  if (!state) return null;

  const { azimuth, elevation, rangeSat } = ecfToLookAngles(
    OBSERVER,
    eciToEcf(state.position, gstime(date))
  );

  // The sun's light on it: 0 lit, 1 in the umbra.
  const shade = shadowFraction(sunPos(jday(date)).rsun, state.position);
  const cosEl = Math.cos(elevation);

  return {
    direction: [
      cosEl * Math.sin(azimuth),
      Math.sin(elevation),
      -cosEl * Math.cos(azimuth),
    ],
    elevation: elevation / RAD,
    shade,
    range: rangeSat,
    magnitude:
      satellite.standard +
      5 * Math.log10(rangeSat / 1000) -
      2.5 * Math.log10(Math.max(1 - shade, 1e-4)),
  };
}
