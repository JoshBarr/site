import { hilltop, readings as series, unescape } from "./hilltop";

// The sea off Baring Head as it's measured, by Greater Wellington Regional
// Council's wave buoy through their Hilltop server (./hilltop.ts): moored
// in open water a kilometre or two south of the head, outside the harbour
// entrance, so what it rides is Cook Strait's sea, not the harbour's. Every
// half hour it sends what the last one's waves were: their significant
// height (the mean of the highest third), those waves' period, and where
// they came from; they reach Hilltop twenty minutes or so later. There are
// two buoys, North (A) and South (B), one of them reporting at a time.

/** The buoys' sites: not the ones retired, nor each one's "-Offline" twin. */
const BUOY =
  /^Wellington Harbour at Baring Head Wave Buoy \((?:North \(A\)|South \(B\))\)$/;

/** Each series wanted, by its data source's name. */
const SERIES = {
  height: "Significant Wave Height (Hsig)",
  period: "Significant Wave Period (Tsig)",
  direction: "Wave Direction",
} as const;

/** A buoy not heard from in this long has nothing to say of the sea, ms. */
const FRESH = 2 * 3600_000;

/**
 * Readings this long before a buoy's newest are averaged with it, ms: the
 * hour's three. One half hour's waves are few enough that their height
 * wanders a tenth either way, and their direction ten degrees.
 */
const AVERAGED = 65 * 60_000;

export interface Waves {
  /** When the newest reading averaged was taken, epoch ms. */
  time: number;
  /** Significant wave height, m. */
  height: number;
  /** The period of the highest third of the waves (Tsig), s. */
  period: number;
  /** Degrees clockwise from north: where the waves come from. */
  direction: number;
}

interface Reading {
  at: number;
  height: number;
  period: number;
  direction: number;
}

type Measurement = keyof typeof SERIES;

const MEASUREMENTS: Measurement[] = ["height", "period", "direction"];

/** A buoy's series: each measurement's values by when they were taken. */
type Measured = Map<Measurement, Map<number, number>>;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** The readings a buoy has all three measurements for, oldest first. */
function whole(found: Measured) {
  const complete: Reading[] = [];

  for (const [at, height] of found.get("height") ?? []) {
    const period = found.get("period")?.get(at);
    const direction = found.get("direction")?.get(at);

    if (period === undefined || direction === undefined) continue;

    // A buoy adrift or ashore reports nothing like waves.
    if (!(height > 0) || !(period > 0)) continue;

    complete.push({ at, height, period, direction });
  }

  return complete.sort((a, b) => a.at - b.at);
}

/**
 * The sea off Baring Head over the hour to the buoy's newest reading, at
 * `now` (epoch ms); null if neither buoy's been heard from lately.
 */
export async function fetchWaves(now = Date.now()): Promise<Waves | null> {
  const minutes = Math.ceil((FRESH + AVERAGED) / 60_000);

  // The buoys are in with the tide gauges; no collection's theirs alone.
  const body = await hilltop({
    Request: "GetData",
    Collection: "Tide Levels",
    TimeInterval: `PT${minutes}M/now`,
  });

  const buoys = new Map<string, Measured>();

  for (const [, name, inside] of body.matchAll(
    /<Measurement SiteName="([^"]*)">([\s\S]*?)<\/Measurement>/g
  )) {
    const site = unescape(name);
    const source = /<DataSource Name="([^"]*)"/.exec(inside)?.[1] ?? "";

    const measurement = MEASUREMENTS.find(
      (key) => SERIES[key] === unescape(source)
    );

    if (!BUOY.test(site) || !measurement) continue;

    const found: Measured = buoys.get(site) ?? new Map();

    found.set(
      measurement,
      new Map(series(inside).map(({ at, value }) => [at, value]))
    );

    buoys.set(site, found);
  }

  // Whichever buoy's reported last.
  const [latest] = [...buoys.values()]
    .flatMap((found) => {
      const readings = whole(found);
      const newest = readings.at(-1);

      return newest ? [{ readings, newest }] : [];
    })
    .sort((a, b) => b.newest.at - a.newest.at);

  if (!latest || !(now - latest.newest.at <= FRESH)) return null;

  const { readings, newest } = latest;
  const hour = readings.filter(({ at }) => at >= newest.at - AVERAGED);

  // Heights by their energy, which goes as the square; directions as
  // vectors, so 350° and 10° make north.
  const energy =
    hour.reduce((sum, { height }) => sum + height * height, 0) / hour.length;

  const period =
    hour.reduce((sum, reading) => sum + reading.period, 0) / hour.length;

  const toward = (part: (angle: number) => number) =>
    hour.reduce((sum, reading) => sum + part(radians(reading.direction)), 0);

  const direction =
    (Math.atan2(toward(Math.sin), toward(Math.cos)) * 180) / Math.PI;

  return {
    time: newest.at,
    height: Math.round(Math.sqrt(energy) * 100) / 100,
    period: Math.round(period * 10) / 10,
    direction: (Math.round(direction) + 360) % 360,
  };
}
