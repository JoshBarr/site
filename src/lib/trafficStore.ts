import { fetchTraffic } from "./nzta";
import { canStore, getRedis } from "./redis";
import type { TrafficSpeeds } from "./traffic";

// NZTA's speeds as last fetched, kept in Upstash Redis so they're fetched
// at most every REFRESH however many people are watching. NZTA takes 15
// seconds or so to answer, so requests get the stored speeds straight away
// and whichever finds them due fetches new ones after it's answered.

/** The latest `Snapshot`. Never expires: it's the last known good. */
const SNAPSHOT = "traffic:snapshot";
/** Held by whoever's refreshing, for REFRESH. */
const LOCK = "traffic:lock";

/** How often NZTA is asked, at most: its speeds move every minute or two. */
const REFRESH = 60_000;

export interface Snapshot extends TrafficSpeeds {
  /** When it was fetched, epoch ms. */
  time: number;
}

/** Without Redis (in development, say), this instance's last fetch. */
let local: Snapshot | null = null;
let localFetch: Promise<Snapshot> | null = null;

async function fetchSnapshot(): Promise<Snapshot> {
  return { time: Date.now(), ...(await fetchTraffic()) };
}

/**
 * The stored speeds, and a refresh to run after answering when they're due
 * and nobody else is fetching them. With nothing stored yet, this waits for
 * the first fetch.
 */
export async function loadTraffic(): Promise<{
  snapshot: Snapshot | null;
  refresh: Promise<unknown> | null;
}> {
  if (!canStore) {
    if (!local || Date.now() - local.time >= REFRESH) {
      localFetch ??= fetchSnapshot().finally(() => (localFetch = null));
      const pending = localFetch
        .then((s) => (local = s))
        .catch((e) => console.error("[traffic] refresh failed:", e));
      if (!local) await pending;
    }
    return { snapshot: local, refresh: null };
  }

  const redis = getRedis();
  const snapshot = await redis.get<Snapshot>(SNAPSHOT);
  if (snapshot && Date.now() - snapshot.time < REFRESH) {
    return { snapshot, refresh: null };
  }
  if ((await redis.set(LOCK, 1, { nx: true, px: REFRESH })) !== "OK") {
    return { snapshot, refresh: null };
  }
  const refresh = fetchSnapshot().then((fresh) =>
    redis.set(SNAPSHOT, fresh).then(() => fresh)
  );
  if (snapshot) {
    return {
      snapshot,
      refresh: refresh.catch((e) =>
        console.error("[traffic] refresh failed:", e)
      ),
    };
  }
  return { snapshot: await refresh, refresh: null };
}
