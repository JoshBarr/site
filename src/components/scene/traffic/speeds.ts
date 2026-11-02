import type { TrafficSpeeds } from "../../../lib/traffic";
import type { Carriageway } from "./roads";
import { nztmToWorld, TileIndex } from "../terrain/manifest";

// What traffic's like along a carriageway, in bins: how fast it goes, from
// NZTA's speeds, and how closely it's packed, from that and the time of
// day. NZTA measures speed, not how many vehicles there are, so the density
// is a model: slow traffic on an open road is a queue, packed as tight as
// drivers leave gaps at that speed; free-flowing traffic is as busy as the
// hour usually is.

/** Bins along a carriageway, m. */
export const BIN = 20;

/** Gaps drivers keep, for the density of queues: as the sim's drivers. */
export const MIN_GAP = 2;
export const HEADWAY = 1.2;
/** An average vehicle's length, m, trucks and all. */
const MEAN_LENGTH = 5;

/**
 * Free-flowing traffic per lane, vehicles an hour, by hour from midnight:
 * weekdays toward the city and away from it, and weekends either way. A
 * guess with the shape of Wellington's commute, not counts.
 */
const WEEKDAY_IN = [
  60, 40, 30, 30, 50, 200, 800, 1500, 1500, 1000, 800, 800, 850, 850, 900, 1000,
  1100, 1100, 800, 550, 400, 330, 220, 120,
];
const WEEKDAY_OUT = [
  60, 40, 30, 30, 40, 120, 450, 850, 900, 800, 800, 800, 850, 850, 950, 1200,
  1500, 1500, 1000, 600, 450, 350, 230, 120,
];
const WEEKEND = [
  120, 80, 60, 40, 40, 80, 180, 300, 500, 700, 850, 950, 950, 950, 950, 900,
  850, 800, 650, 500, 400, 330, 250, 180,
];
/** Where "toward the city" is toward: Lambton Quay, NZTM. */
const CITY: [number, number] = [1748700, 5427800];

/**
 * Town streets at 50 or less run this far under their limit at best, for
 * the lights: slower than that, they're congested.
 */
const TOWN_FREE = 0.7;
/**
 * Traffic through a stretch is held to what its narrowest point nearby
 * carries, this far either way, m: lanes on the approach to a lane drop
 * aren't all full.
 */
const NARROWS = 600;
/** Slowest any traffic's shown going, m/s: a crawl, not a car park. */
const CRAWL = 1.5;

/** How busy the hour is, per lane, vehicles a second. */
function demand(date: Date, inbound: boolean) {
  const parts = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const weekend = ["Sat", "Sun"].includes(get("weekday"));
  const profile = weekend ? WEEKEND : inbound ? WEEKDAY_IN : WEEKDAY_OUT;
  const hour = Number(get("hour")) + Number(get("minute")) / 60;
  const a = profile[Math.floor(hour) % 24];
  const b = profile[(Math.floor(hour) + 1) % 24];
  return (a + (b - a) * (hour % 1)) / 3600;
}

/**
 * In a queue, drivers would go this much faster than they can: it's how
 * close they're packed that holds them to the queue's speed.
 */
const EAGER = 0.3;
/**
 * How much further apart than their usual gap drivers wanting EAGER more
 * settle, in the intelligent driver model, at the speed they're held to.
 */
const QUEUE_SPREAD = 1 / Math.sqrt(1 - (1 / (1 + EAGER)) ** 4);

/** Vehicles a metre in a lane of queue moving at `v`, m/s. */
function queueDensity(v: number) {
  return 1 / (MEAN_LENGTH + (MIN_GAP + v * HEADWAY) * QUEUE_SPREAD);
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** A carriageway's bins: which way's the city, lanes, and the limit. */
export interface Bins {
  count: number;
  inbound: Uint8Array;
  lanes: Uint8Array;
  /** The fewest lanes within NARROWS. */
  narrows: Uint8Array;
  /** m/s. */
  limit: Float32Array;
  town: Uint8Array;
}

export function createBins(road: Carriageway, index: TileIndex): Bins {
  const count = Math.ceil(road.length / BIN) + 1;
  const bins: Bins = {
    count,
    inbound: new Uint8Array(count),
    lanes: new Uint8Array(count),
    narrows: new Uint8Array(count),
    limit: new Float32Array(count),
    town: new Uint8Array(count),
  };
  const [cx, cz] = nztmToWorld(index.manifest, ...CITY);
  let hint = 0;
  for (let b = 0; b < count; b++) {
    const i = (hint = road.locate((b + 0.5) * BIN, hint));
    const tx = road.x[i + 1] - road.x[i];
    const tz = road.z[i + 1] - road.z[i];
    bins.inbound[b] = tx * (cx - road.x[i]) + tz * (cz - road.z[i]) > 0 ? 1 : 0;
    bins.lanes[b] = road.lanes[i];
    bins.limit[b] = road.limit[i];
    bins.town[b] = road.limit[i] <= 50 / 3.6 + 0.1 ? 1 : 0;
  }
  const reach = NARROWS / BIN;
  for (let b = 0; b < count; b++) {
    let fewest = bins.lanes[b];
    for (
      let k = Math.max(b - reach, 0);
      k <= Math.min(b + reach, count - 1);
      k++
    ) {
      fewest = Math.min(fewest, bins.lanes[k]);
    }
    bins.narrows[b] = fewest;
  }
  return bins;
}

/**
 * Speeds forced from the page's `?traffic=`: "jam", "free", or km/h
 * everywhere. Null to use NZTA's.
 */
export type Override = "jam" | "free" | number | null;

export function overrideFromUrl(): Override {
  const value = new URLSearchParams(location.search).get("traffic");
  if (value === "jam" || value === "free") return value;
  const kmh = Number(value);
  return value && Number.isFinite(kmh) && kmh > 0 ? kmh : null;
}

/**
 * Into `speed`, how fast traffic goes in each bin, m/s: NZTA's link there,
 * else its leg, else near the limit; smoothed over a couple of hundred
 * metres, since drivers see a queue coming.
 */
export function fillSpeeds(
  road: Carriageway,
  bins: Bins,
  speeds: TrafficSpeeds | null,
  override: Override,
  speed: Float32Array
) {
  for (let b = 0; b < bins.count; b++) {
    const s = (b + 0.5) * BIN;
    const limit = bins.limit[b];
    const free = limit * (bins.town[b] ? TOWN_FREE : 0.95);
    let kmh = NaN;
    if (override === "jam") kmh = 8;
    else if (override === "free") kmh = NaN;
    else if (typeof override === "number") kmh = override;
    else if (speeds) {
      let sum = 0;
      let n = 0;
      for (const [a, z, key] of road.links) {
        if (s >= a && s < z && speeds.links[key] !== undefined) {
          sum += speeds.links[key];
          n++;
        }
      }
      if (!n) {
        for (const [a, z, key] of road.legs) {
          if (s >= a && s < z && speeds.legs[key] !== undefined) {
            sum += speeds.legs[key];
            n++;
          }
        }
      }
      if (n) kmh = sum / n;
    }
    speed[b] = Number.isNaN(kmh)
      ? free
      : Math.min(Math.max(kmh / 3.6, CRAWL), limit * 1.1);
  }
  // Two passes of a moving average, ±4 bins.
  const scratch = new Float32Array(bins.count);
  for (let pass = 0; pass < 2; pass++) {
    for (let b = 0; b < bins.count; b++) {
      let sum = 0;
      let n = 0;
      for (
        let k = Math.max(b - 4, 0);
        k <= Math.min(b + 4, bins.count - 1);
        k++
      ) {
        sum += speed[k];
        n++;
      }
      scratch[b] = sum / n;
    }
    speed.set(scratch);
  }
}

/**
 * Into `density`, vehicles a metre in each lane of each bin, for traffic
 * going `speed`: as busy as the hour is where it's flowing freely, and
 * where it's slow, a queue (unless it's the middle of the night, when slow
 * traffic's more likely roadworks or the lights than a jam). Into `eager`,
 * how much faster than `speed` drivers there want to go: more, the more
 * it's a queue.
 */
export function fillDensity(
  bins: Bins,
  speed: Float32Array,
  date: Date,
  density: Float32Array,
  eager: Float32Array
) {
  const flow = [demand(date, false), demand(date, true)];
  for (let b = 0; b < bins.count; b++) {
    const v = speed[b];
    const q = (flow[bins.inbound[b]] * bins.narrows[b]) / bins.lanes[b];
    const queue = queueDensity(v);
    const free = Math.min(q / Math.max(v, CRAWL), queue);
    const freeSpeed = bins.limit[b] * (bins.town[b] ? TOWN_FREE : 0.95);
    const congested =
      smoothstep(0.85, 0.5, v / freeSpeed) * smoothstep(150, 600, q * 3600);
    density[b] = free + (queue - free) * congested;
    eager[b] = 1 + EAGER * congested;
  }
}
