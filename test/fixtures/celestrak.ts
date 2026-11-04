import { http, HttpResponse } from "msw/http";
import type { Orbit } from "../../src/lib/satellites";
import { server } from "../msw";

// CelesTrak's visual group, as its OMM JSON gives it.

/** The ISS, as CelesTrak had it on 2026-11-04. */
export const ISS: Orbit = {
  OBJECT_NAME: "ISS (ZARYA)",
  OBJECT_ID: "1998-067A",
  EPOCH: "2026-11-03T22:01:52.915584",
  MEAN_MOTION: 15.49169061,
  ECCENTRICITY: 0.0007181,
  INCLINATION: 51.6329,
  RA_OF_ASC_NODE: 328.6334,
  ARG_OF_PERICENTER: 345.0321,
  MEAN_ANOMALY: 15.0454,
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 999,
  BSTAR: 0.00010662,
  MEAN_MOTION_DOT: 0.00005463,
  MEAN_MOTION_DDOT: 0,
};

/** Hubble, the same day. */
export const HST: Orbit = {
  OBJECT_NAME: "HST",
  OBJECT_ID: "1990-037B",
  EPOCH: "2026-11-04T02:50:48.419808",
  MEAN_MOTION: 15.32167761,
  ECCENTRICITY: 0.000165,
  INCLINATION: 28.4725,
  RA_OF_ASC_NODE: 203.1629,
  ARG_OF_PERICENTER: 274.0074,
  MEAN_ANOMALY: 86.0334,
  NORAD_CAT_ID: 20580,
  ELEMENT_SET_NO: 999,
  BSTAR: 0.00013856,
  MEAN_MOTION_DOT: 0.00004664,
  MEAN_MOTION_DDOT: 0,
};

/** Tiangong's core module, the same day. */
export const CSS: Orbit = {
  OBJECT_NAME: "CSS (TIANHE)",
  OBJECT_ID: "2021-035A",
  EPOCH: "2026-11-04T03:21:23.563584",
  MEAN_MOTION: 15.61367894,
  ECCENTRICITY: 0.0004451,
  INCLINATION: 41.4684,
  RA_OF_ASC_NODE: 191.6632,
  ARG_OF_PERICENTER: 256.3927,
  MEAN_ANOMALY: 103.6416,
  NORAD_CAT_ID: 48274,
  ELEMENT_SET_NO: 999,
  BSTAR: 0.00023381,
  MEAN_MOTION_DOT: 0.00020216,
  MEAN_MOTION_DDOT: 0,
};

/** Serves `orbits` as the visual group, with fields SGP4 doesn't need. */
export function celestrak(orbits: object[] = [ISS, HST], status = 200) {
  const requests: URL[] = [];

  server.use(
    http.get("https://celestrak.org/NORAD/elements/gp.php", ({ request }) => {
      requests.push(new URL(request.url));

      return HttpResponse.json(
        orbits.map((orbit) => ({
          ...orbit,
          EPHEMERIS_TYPE: 0,
          CLASSIFICATION_TYPE: "U",
          REV_AT_EPOCH: 59341,
        })),
        { status }
      );
    })
  );

  return { requests };
}
