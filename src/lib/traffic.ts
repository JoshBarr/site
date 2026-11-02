// Live traffic speeds on State Highways 1 and 2 around Wellington: shared
// by /api/traffic and the scene.

/** Speeds as NZTA last gave them. km/h. */
export interface TrafficSpeeds {
  /**
   * By link, keyed "name|length" as public/roads/roads.json lists them:
   * a few hundred metres of one carriageway each.
   */
  links: Record<string, number>;
  /**
   * By leg, keyed "road direction sequence" (e.g. "SH1 I 10"), where NZTA
   * has a reading: a few km each, for where links aren't placed.
   */
  legs: Record<string, number>;
}

export interface TrafficResponse extends TrafficSpeeds {
  /** Server clock, epoch ms, so clients can correct for their own. */
  time: number;
  /** When the speeds were fetched from NZTA, epoch ms. */
  fetched: number;
}

/** Speeds older than this are no use: traffic's moved on. */
export const STALE = 20 * 60_000;
