// Solar position for Wellington, from UTC so it's right for any visitor's
// timezone and across daylight saving. NOAA general solar position equations:
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF (accurate to ~0.1°).

export const WELLINGTON = { latitude: -41.2865, longitude: 174.7762 };

const RAD = Math.PI / 180;

export interface SunPosition {
  /** Degrees clockwise from true north. */
  azimuth: number;
  /** Degrees above the horizon (negative below). */
  altitude: number;
}

export function sunPosition(
  date: Date = new Date(),
  { latitude, longitude } = WELLINGTON
): SunPosition {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - start) / 86400000);
  const hours =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600;
  const daysInYear = date.getUTCFullYear() % 4 === 0 ? 366 : 365;

  // Fractional year, radians.
  const g = ((2 * Math.PI) / daysInYear) * (dayOfYear + (hours - 12) / 24);

  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));

  const declination =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);

  // True solar time in minutes, then hour angle.
  const solarMinutes = hours * 60 + equationOfTime + 4 * longitude;
  const hourAngle = (solarMinutes / 4 - 180) * RAD;

  const lat = latitude * RAD;
  const cosZenith =
    Math.sin(lat) * Math.sin(declination) +
    Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));

  const azimuth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat)
  );

  return {
    azimuth: (azimuth / RAD + 180 + 360) % 360,
    altitude: 90 - zenith / RAD,
  };
}

/**
 * Unit vector toward the sun in the scene frame (x east, y up, z south).
 */
export function sunDirection({
  azimuth,
  altitude,
}: SunPosition): [number, number, number] {
  const az = azimuth * RAD;
  const alt = altitude * RAD;
  return [
    Math.cos(alt) * Math.sin(az),
    Math.sin(alt),
    -Math.cos(alt) * Math.cos(az),
  ];
}
