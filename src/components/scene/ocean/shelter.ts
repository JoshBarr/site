// How much of the open sea reaches each stretch of water. The wave buoy
// rides Cook Strait off Baring Head; the harbour behind the heads doesn't
// get its sea, and nor does a bay with a hill in the way. The open sea is
// followed in from the map's edge along the way it travels, and along a fan
// of ways either side, since its waves don't all come from one: land stops
// it, and shoal water wears it down the further it runs through it, the
// harbour's entrance and floor in particular. What reaches a place, over
// what set out, is its exposure.
//
// It's the look of the thing, not its physics: rays are straight, so
// nothing bends round a headland or onto a reef, and what the shoals take
// is a guess (the harbour's swell isn't measured anywhere).

/** The map's cells a side. */
export const SHELTER_SIZE = 256;

/** Either side of the sea's direction, the ways it's followed in, degrees. */
const FAN = [-40, -30, -20, -10, 0, 10, 20, 30, 40];

/** How far the sea's waves stray from its direction, degrees, about. */
const SPREAD = 20;

/**
 * Water shallower than this is as good as land, m: a cell half beach lets
 * half through.
 */
const DRY = 2;

/**
 * Waves feel the bottom in water shallower than this share of their length,
 * and no deeper than this, m: the strait off the south coast is deeper
 * within a kilometre or two, the harbour and its entrance nowhere.
 */
const FELT = 0.25;
const DEEPEST_FELT = 30;

/**
 * Through water they feel the bottom of, waves lose 1/e of their energy in
 * this far, m, where it's shallowest, and less the deeper it is. A guess:
 * with it a five-metre southerly is about half that in the entrance, and
 * well under a metre by Somes Island and Petone.
 */
const WORN = 2500;

export interface Incoming {
  /** Degrees clockwise from north: where the sea comes from. */
  from: number;
  /** Its dominant wavelength, m. */
  length: number;
  /**
   * For a sea the wind's raising here, not one arrived from elsewhere: the
   * open water it takes to raise it whole, m. Past land, it grows back.
   */
  grows?: number;
}

/**
 * How much of a sea going (tx, tz) gets to each cell, 0..1 of its energy,
 * into `reached`: each cell takes what the one upstream of it got, less
 * what it stops itself.
 */
function follow(
  /** Each cell's log of what it lets through over its own width. */
  lets: Float32Array,
  /** What a cell of open water gives back to a sea that grows. */
  regrown: number,
  tx: number,
  tz: number,
  reached: Float32Array
) {
  const n = SHELTER_SIZE;
  // Row by row if it runs more north–south than east–west, else column by
  // column: a step is one row (or column) on, and a part of one across.
  const rows = Math.abs(tz) >= Math.abs(tx);
  const along = rows ? tz : tx;
  const across = (rows ? tx : tz) / Math.abs(along);
  const step = Math.hypot(1, across);
  const forward = along > 0;

  for (let a = 0; a < n; a++) {
    const line = forward ? a : n - 1 - a;
    const before = forward ? line - 1 : line + 1;

    for (let b = 0; b < n; b++) {
      let arriving = 1;

      // Off the map it's the open sea.
      if (before >= 0 && before < n) {
        const at = b - across;
        const low = Math.floor(at);
        const part = at - low;

        const upstream = (cell: number) =>
          cell < 0 || cell >= n
            ? 1
            : reached[rows ? before * n + cell : cell * n + before];

        arriving = upstream(low) * (1 - part) + upstream(low + 1) * part;
      }

      const i = rows ? line * n + b : b * n + line;
      // Deep water lets it all through, and most of the sea is deep.
      const through = lets[i] === 0 ? 1 : Math.exp(lets[i] * step);

      reached[i] =
        (arriving + (1 - arriving) * Math.min(regrown * step, 1)) * through;
    }
  }
}

/**
 * Works out each cell's exposure to `sea`, 0..255 of its height, over a
 * square map `SHELTER_SIZE` cells a side of `cell` metres each, row 0 the
 * northern edge, into `into`, which is only written once it's all known.
 * `depth` is the water's at each cell, m: 0 on land. A step at a time, a
 * millisecond or two each, so a frame needn't wait for the whole of it.
 */
export function* exposing(
  depth: Float32Array,
  cell: number,
  sea: Incoming,
  into: Uint8Array
) {
  const count = SHELTER_SIZE * SHELTER_SIZE;
  const felt = Math.min(sea.length * FELT, DEEPEST_FELT);
  const lets = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const shallow = Math.max(1 - depth[i] / felt, 0);

    lets[i] = Math.log(Math.min(depth[i] / DRY, 1)) - (shallow * cell) / WORN;
  }

  const reached = new Float32Array(count);
  const energy = new Float32Array(count);
  let weights = 0;

  for (const off of FAN) {
    yield;

    const weight = Math.exp(-0.5 * (off / SPREAD) ** 2);
    // Where it's going: north is -z.
    const bearing = ((sea.from + off + 180) * Math.PI) / 180;

    follow(
      lets,
      sea.grows ? cell / sea.grows : 0,
      Math.sin(bearing),
      -Math.cos(bearing),
      reached
    );

    for (let i = 0; i < count; i++) energy[i] += reached[i] * weight;
    weights += weight;
  }

  yield;

  // Height goes as the root of energy.
  for (let i = 0; i < count; i++) {
    into[i] = Math.round(Math.sqrt(energy[i] / weights) * 255);
  }
}

/** Each cell's exposure to `sea` (see `exposing`), all at once. */
export function exposure(
  depth: Float32Array,
  cell: number,
  sea: Incoming,
  into = new Uint8Array(SHELTER_SIZE * SHELTER_SIZE)
) {
  // Run to its end; it gives nothing back along the way.
  for (const _ of exposing(depth, cell, sea, into));

  return into;
}

/**
 * How high the longest cascade stands at an exposure of 0..1, against the
 * open sea: `open` of its energy is the open sea's alone (./spectrum.ts),
 * and goes with the square of the exposure.
 */
export const standing = (open: number, exposed: number) =>
  Math.sqrt(1 - open * (1 - exposed * exposed));
