// Buses going the same way down the same road, kept from driving into the
// back of each other.

/** Pointing this nearly the same way (cosine), two buses share a lane. */
const SAME_WAY = 0.8;

/** Closer side to side than this, m, two buses share a lane. */
const LANE = 2.5;

/**
 * Places, heading and how far back each bus has to go, for up to `max`
 * buses: set `x`, `z` (its middle) and `dx`, `dz` (a unit heading, or 0 if
 * it has none) for the first `n`, then `resolve`.
 */
export function createSpacing(max: number) {
  const x = new Float32Array(max);
  const z = new Float32Array(max);
  const dx = new Float32Array(max);
  const dz = new Float32Array(max);
  const back = new Float32Array(max);
  const order: number[] = [];

  /**
   * How far back along its way each of the first `n` buses has to go, m,
   * to be `gap` behind the bus ahead of it in its lane, buses `length`
   * long. Pairs are found by sweeping along x, so it's cheap.
   */
  function resolve(n: number, length: number, gap: number) {
    const reach = length + gap;

    order.length = n;

    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => x[a] - x[b]);
    back.fill(0, 0, n);

    for (let p = 0; p < n; p++) {
      const a = order[p];

      for (let q = p + 1; q < n; q++) {
        const b = order[q];

        if (x[b] - x[a] >= reach) break;
        const ex = x[b] - x[a];
        const ez = z[b] - z[a];

        if (Math.abs(ez) >= reach) continue;

        if (dx[a] * dx[b] + dz[a] * dz[b] < SAME_WAY) continue;
        // Along and across a's heading: b's ahead of a if `ahead` > 0.
        const ahead = ex * dx[a] + ez * dz[a];
        const across = Math.abs(ex * dz[a] - ez * dx[a]);

        if (across >= LANE || Math.abs(ahead) >= reach) continue;
        const behind = ahead > 0 || (ahead === 0 && a > b) ? a : b;

        back[behind] = Math.max(back[behind], reach - Math.abs(ahead));
      }
    }

    return back;
  }

  return { x, z, dx, dz, resolve };
}
