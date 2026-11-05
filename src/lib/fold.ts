// Folding the live table's logs (see plans/dynamo.md) into what the scene
// draws: each poll is everything one fetch said, so a vehicle's trail is its
// fixes across the polls in a window.

/** A poll as the stores fold it: when it was, and what it held. */
export interface Poll<D> {
  /** Epoch ms. */
  sk: number;
  data: D;
}

type TrailPoint = [number, number, number];

interface Fixed {
  id: string;
  position: [number, number];
  /** When the fix was taken, epoch ms. */
  time: number;
}

/**
 * Those of `fixes` still worth showing at `now`: heard from within `stale`
 * of the newest of them, so one that's finished its trip goes while the rest
 * carry on. Measured from the newest rather than from now, a feed that stops
 * for a while (Metlink's has, for minutes) leaves everything where it was
 * last heard instead of emptying the map; after `quiet` with no word, they go.
 */
export function current<T extends { time: number }>(
  fixes: T[],
  now: number,
  stale: number,
  quiet: number
): T[] {
  let newest = -Infinity;

  for (const { time } of fixes) newest = Math.max(newest, time);

  return fixes.filter(
    ({ time }) => newest - time <= stale && now - time <= quiet
  );
}

/** `points` in time order, each time once. */
export function byTime(points: TrailPoint[]) {
  const sorted = [...points].sort((a, b) => a[2] - b[2]);

  return sorted.filter((point, i) => i === 0 || point[2] !== sorted[i - 1][2]);
}

/**
 * Each vehicle in the newest of `polls` (oldest first) as it was then, with
 * its fixes across them all since `since` as its trail, ending at its
 * position. Fixes from before the last one `sameRun` says isn't on the same
 * run (a bus's trip, say) are left behind.
 */
export function foldTrails<T extends Fixed>(
  polls: T[][],
  since: number,
  sameRun: (fix: T, latest: T) => boolean = () => true
): (T & { trail: TrailPoint[] })[] {
  const fixes = new Map<string, T[]>();

  for (const poll of polls) {
    for (const fix of poll) {
      const known = fixes.get(fix.id);

      if (known) known.push(fix);
      else fixes.set(fix.id, [fix]);
    }
  }

  return (polls.at(-1) ?? []).map((latest) => {
    // Its own fix always, even from before `since`: a vehicle that's gone
    // quiet but isn't stale yet still has its position.
    const earlier = (fixes.get(latest.id) ?? [])
      .filter(
        (fix) => fix === latest || (fix.time > since && fix.time <= latest.time)
      )
      .sort((a, b) => a.time - b.time);

    const cut = earlier.findLastIndex((fix) => !sameRun(fix, latest));

    const trail = byTime(
      earlier
        .slice(cut + 1)
        .map(({ position, time }): TrailPoint => [...position, time])
    );

    return { ...latest, trail };
  });
}
