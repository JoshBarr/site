import { Matrix3, Vector3 } from "three/webgpu";
import { WELLINGTON } from "../sun";

// Where the stars and planets are over Wellington. Directions are in the
// J2000 equatorial frame (x to the March equinox, z to the celestial north
// pole), turned onto the scene's (x east, y up, z south) by the Earth's
// spin. Precession since 2000 (a third of a degree) is left out.

const RAD = Math.PI / 180;

/** Days since J2000.0 (2000-01-01 12:00 TT, near enough UTC). */
const daysSinceJ2000 = (time: number) => time / 86_400_000 - 10957.5;

/** Unit vector toward right ascension `ra` and declination `dec`, degrees. */
export function equatorial(ra: number, dec: number): [number, number, number] {
  const cosDec = Math.cos(dec * RAD);

  return [
    cosDec * Math.cos(ra * RAD),
    cosDec * Math.sin(ra * RAD),
    Math.sin(dec * RAD),
  ];
}

/**
 * The rotation from equatorial directions to the scene's at `time` (epoch
 * ms), into `target`: by local sidereal time, then from the equator to
 * Wellington's horizon.
 */
export function skyRotation(time: number, target = new Matrix3()) {
  const days = daysSinceJ2000(time);

  // Greenwich mean sidereal time, then Wellington's.
  const lst =
    (280.46061837 + 360.98564736629 * days + WELLINGTON.longitude) * RAD;

  const lat = WELLINGTON.latitude * RAD;
  const [c, s] = [Math.cos(lst), Math.sin(lst)];
  const [cl, sl] = [Math.cos(lat), Math.sin(lat)];

  // Hour angle frame: (cos δ cos H, −cos δ sin H, sin δ) = Rz(−lst)·v.
  // East is its y; up, cos φ x + sin φ z; south, sin φ x − cos φ z.
  return target.set(-s, c, 0, cl * c, cl * s, sl, sl * c, sl * s, -cl);
}

export const PLANETS = [
  "mercury",
  "venus",
  "mars",
  "jupiter",
  "saturn",
] as const;

type PlanetName = (typeof PLANETS)[number];

interface Elements {
  /** Semi-major axis (au), eccentricity, inclination, mean longitude,
   * longitude of perihelion, longitude of the ascending node (degrees):
   * at J2000, then their rates per century. */
  at: [number, number, number, number, number, number];
  rate: [number, number, number, number, number, number];
}

/**
 * Keplerian elements and rates, J2000 ecliptic, for 1800–2050 AD: E M
 * Standish, "Keplerian Elements for Approximate Positions of the Major
 * Planets" (JPL), table 1. Good to a few arcminutes for the inner planets.
 */
const ELEMENTS = {
  earth: {
    at: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0],
    rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
  },
  mercury: {
    at: [
      0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593,
    ],
    rate: [
      0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689,
      -0.12534081,
    ],
  },
  venus: {
    at: [
      0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718,
      76.67984255,
    ],
    rate: [
      0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329,
      -0.27769418,
    ],
  },
  mars: {
    at: [
      1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
    ],
    rate: [
      0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088,
      -0.29257343,
    ],
  },
  jupiter: {
    at: [
      5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
    ],
    rate: [
      -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668,
      0.20469106,
    ],
  },
  saturn: {
    at: [
      9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831,
      113.66242448,
    ],
    rate: [
      -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216,
      -0.28867794,
    ],
  },
} satisfies Record<PlanetName | "earth", Elements>;

/**
 * Brightness: magnitude at 1 au from the sun and the Earth, full on, then
 * how it dims with phase angle i (degrees), as a·i + b·i² + c·i³. Meeus,
 * Astronomical Algorithms, ch. 41; Saturn's rings, which add up to half a
 * magnitude, are left out.
 */
const BRIGHTNESS = {
  mercury: [-0.42, 0.038, -0.000273, 0.000002],
  venus: [-4.4, 0.0009, 0.000239, -0.00000065],
  mars: [-1.52, 0.016, 0, 0],
  jupiter: [-9.4, 0.005, 0, 0],
  saturn: [-8.88, 0, 0, 0],
} satisfies Record<PlanetName, [number, number, number, number]>;

/** Heliocentric position, J2000 ecliptic, au, `centuries` since J2000. */
function heliocentric({ at, rate }: Elements, centuries: number) {
  const [a, e, i, L, peri, node] = at.map((v, k) => v + rate[k] * centuries);
  const w = (peri - node) * RAD;
  const M = (((((L - peri) % 360) + 540) % 360) - 180) * RAD;

  // Kepler's equation, by Newton's method.
  let E = M + e * Math.sin(M);

  for (let k = 0; k < 6; k++) {
    E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }

  const x = a * (Math.cos(E) - e);
  const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const [cw, sw] = [Math.cos(w), Math.sin(w)];
  const [cn, sn] = [Math.cos(node * RAD), Math.sin(node * RAD)];
  const [ci, si] = [Math.cos(i * RAD), Math.sin(i * RAD)];

  return [
    (cw * cn - sw * sn * ci) * x + (-sw * cn - cw * sn * ci) * y,
    (cw * sn + sw * cn * ci) * x + (-sw * sn + cw * cn * ci) * y,
    sw * si * x + cw * si * y,
  ];
}

/** The J2000 obliquity of the ecliptic. */
const OBLIQUITY = 23.43928 * RAD;

export interface Planet {
  name: PlanetName;
  /** Unit vector toward it, equatorial. */
  direction: [number, number, number];
  magnitude: number;
}

/** Where each planet Mercury to Saturn is from the Earth at `time`. */
export function planets(time: number): Planet[] {
  const centuries = daysSinceJ2000(time) / 36525;
  const earth = heliocentric(ELEMENTS.earth, centuries);
  const sun = Math.hypot(...earth);

  return PLANETS.map((name) => {
    const helio = heliocentric(ELEMENTS[name], centuries);
    const [x, y, z] = helio.map((v, k) => v - earth[k]);
    const distance = Math.hypot(x, y, z);
    const r = Math.hypot(...helio);

    // Sun–planet–Earth angle, by the cosine rule.
    const phase =
      Math.acos(
        Math.min(
          1,
          Math.max(
            -1,
            (r * r + distance * distance - sun * sun) / (2 * r * distance)
          )
        )
      ) / RAD;

    const [base, a, b, c3] = BRIGHTNESS[name];
    // Ecliptic to equatorial: about x by the obliquity.
    const [c, s] = [Math.cos(OBLIQUITY), Math.sin(OBLIQUITY)];

    return {
      name,
      direction: [
        x / distance,
        (y * c - z * s) / distance,
        (y * s + z * c) / distance,
      ],
      magnitude:
        base +
        5 * Math.log10(r * distance) +
        phase * (a + phase * (b + phase * c3)),
    };
  });
}

/** Earth radii in an astronomical unit. */
const EARTH_RADII_PER_AU = 23_455;

/** Sine and cosine of degrees. */
const sind = (degrees: number) => Math.sin(degrees * RAD);
const cosd = (degrees: number) => Math.cos(degrees * RAD);

export interface Moon {
  /** Unit vector toward it from the Earth's centre, equatorial of date. */
  direction: [number, number, number];
  /** From the Earth's centre, in Earth radii. */
  distance: number;
  /** Sun–Moon–Earth angle, degrees: 0 full, 180 new. */
  phaseAngle: number;
  /** Fraction of the disc lit, 0..1. */
  illuminated: number;
  magnitude: number;
}

/**
 * Where the Moon is at `time`, and how much of it's lit: the Astronomical
 * Almanac's low-precision series (to about 0.3°, a little over its own
 * width), with the Sun from its own short series for the phase. Of date, so
 * placed by skyRotation it's right on the sky to that, precession and all.
 */
export function moon(time: number): Moon {
  const T = daysSinceJ2000(time) / 36525;

  const longitude =
    218.32 +
    481267.881 * T +
    6.29 * sind(135.0 + 477198.87 * T) -
    1.27 * sind(259.3 - 413335.36 * T) +
    0.66 * sind(235.7 + 890534.22 * T) +
    0.21 * sind(269.9 + 954397.74 * T) -
    0.19 * sind(357.5 + 35999.05 * T) -
    0.11 * sind(186.5 + 966404.03 * T);

  const latitude =
    5.13 * sind(93.3 + 483202.02 * T) +
    0.28 * sind(228.2 + 960400.89 * T) -
    0.28 * sind(318.3 + 6003.15 * T) -
    0.17 * sind(217.6 - 407332.21 * T);

  const parallax =
    0.9508 +
    0.0518 * cosd(135.0 + 477198.87 * T) +
    0.0095 * cosd(259.3 - 413335.36 * T) +
    0.0078 * cosd(235.7 + 890534.22 * T) +
    0.0028 * cosd(269.9 + 954397.74 * T);

  const distance = 1 / sind(parallax);

  // Ecliptic to equatorial, about x by the obliquity.
  const [x, y, z] = [
    cosd(latitude) * cosd(longitude),
    cosd(latitude) * sind(longitude),
    sind(latitude),
  ];

  const [c, s] = [Math.cos(OBLIQUITY), Math.sin(OBLIQUITY)];

  // The Sun's longitude, to a hundredth of a degree, and its distance.
  const anomaly = 357.529 + 35999.05 * T;

  const sun =
    280.459 + 36000.77 * T + 1.915 * sind(anomaly) + 0.02 * sind(2 * anomaly);

  const sunDistance = (1.00014 - 0.01671 * cosd(anomaly)) * EARTH_RADII_PER_AU;

  // Elongation from the Sun, then the phase angle across at the Moon.
  const elongation = Math.acos(cosd(latitude) * cosd(longitude - sun));

  const phaseAngle =
    Math.atan2(
      sunDistance * Math.sin(elongation),
      distance - sunDistance * Math.cos(elongation)
    ) / RAD;

  return {
    direction: [x, y * c - z * s, y * s + z * c],
    distance,
    phaseAngle,
    illuminated: (1 + cosd(phaseAngle)) / 2,
    // Allen's, from full at -12.73.
    magnitude: -12.73 + 0.026 * phaseAngle + 4e-9 * phaseAngle ** 4,
  };
}

/**
 * Unit vector toward the Moon from Wellington, in the scene's frame, at
 * `time`: turned by skyRotation, less the observer's offset from the Earth's
 * centre (up to a degree, at the Moon's distance).
 */
export function moonDirection(
  time: number,
  { direction, distance } = moon(time)
): [number, number, number] {
  const [x, y, z] = new Vector3(...direction)
    .applyMatrix3(skyRotation(time))
    .multiplyScalar(distance)
    .sub(UP)
    .normalize()
    .toArray();

  return [x, y, z];
}

const UP = new Vector3(0, 1, 0);
