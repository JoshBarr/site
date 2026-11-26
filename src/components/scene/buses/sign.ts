import { GLYPHS } from "../traffic/signs/dots";

// What a bus's signs show, as their lamps: on the front, where it's going
// and its route number; on the back, the number alone. Metlink says which
// route and trip a bus is on, not what its signs are made of, so each is a
// grid of lamps sized to the sign's place on the model, set in the 5 × 7
// characters of the motorway's signs, doubled where there's room.

/** Lamps down a sign, front or back. */
export const SIGN_ROWS = 18;

/** Lamps across the front sign, and the back one. */
export const FRONT_WIDE = 144;
export const REAR_WIDE = 38;

/** Dark lamps between the two in a band, so neither blurs into the other. */
const BETWEEN = 2;

/** Across the map, the back sign starts here. */
export const REAR_FROM = FRONT_WIDE + BETWEEN;

/** A bus's signs side by side: the front, then the back. */
export const BAND_WIDE = REAR_FROM + REAR_WIDE;

/** A character, in lamps, before any doubling. */
const CHAR = 5;
const TALL = 7;

/** Lamps dark round a sign's edge, and between a destination and the number. */
const MARGIN = 2;
const GAP = 4;

/** A route number's characters at most: Metlink's have up to three. */
const NUMBER = 3;

/** Under two lines of a destination, and between them. */
const LINE_TOP = 1;
const LEADING = 2;

/** Said shorter on a sign than in the timetable. */
const SHORTER: [RegExp, string][] = [
  [/Victoria University of Wellington/i, "Victoria Uni"],
];

/** How wide `text` is set `wide` times its size, in lamps. */
const widthOf = (text: string, wide: number) =>
  text.length ? text.length * (CHAR + 1) * wide - wide : 0;

/**
 * Lights `text`'s lamps in `dots` (BAND_WIDE to a row), its top left
 * corner at `x`, `y`, each lamp of a character `wide` across and `tall`
 * down. What it has no character for is left a gap.
 */
function set(
  dots: Uint8Array,
  text: string,
  x: number,
  y: number,
  wide: number,
  tall: number
) {
  [...text].forEach((character, k) => {
    const glyph = GLYPHS.get(character);

    if (!glyph) return;
    const left = x + k * (CHAR + 1) * wide;

    for (let j = 0; j < TALL * tall; j++) {
      const row = glyph[Math.floor(j / tall)];

      for (let i = 0; i < CHAR * wide; i++) {
        if (row[Math.floor(i / wide)] === "#") {
          dots[(y + j) * BAND_WIDE + left + i] = 255;
        }
      }
    }
  });
}

/**
 * `words` on two lines, split where the longer line's shortest; each cut
 * to `room` characters.
 */
function twoLines(words: string[], room: number) {
  let best = [words.join(" "), ""];

  for (let k = 1; k < words.length; k++) {
    const lines = [words.slice(0, k).join(" "), words.slice(k).join(" ")];

    if (
      Math.max(lines[0].length, lines[1].length) <
      Math.max(best[0].length, best[1].length)
    ) {
      best = lines;
    }
  }

  return best.map((line) => line.slice(0, room).trimEnd());
}

/**
 * A bus's signs as lit lamps, BAND_WIDE × SIGN_ROWS, a row at a time from
 * the top (255 lit, 0 dark): the front in the first FRONT_WIDE columns,
 * the back from REAR_FROM. The front has the route's number at its right,
 * twice the characters' size, and where it's going in what's left: as big
 * if there's room, tall and narrow if not, and on two lines if that's
 * still too long (broken at a " - " if it has one). The back has the
 * number, in the middle.
 */
export function litBusSign(route: string, destination: string): Uint8Array {
  const dots = new Uint8Array(BAND_WIDE * SIGN_ROWS);
  const number = route.trim().toUpperCase().slice(0, NUMBER);
  const across = widthOf(number, 2);
  const middle = Math.floor((SIGN_ROWS - TALL * 2) / 2);

  set(dots, number, FRONT_WIDE - MARGIN - across, middle, 2, 2);
  set(
    dots,
    number,
    REAR_FROM + Math.floor((REAR_WIDE - across) / 2),
    middle,
    2,
    2
  );

  const text = SHORTER.reduce(
    (name, [long, short]) => name.replace(long, short),
    destination
  )
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

  const room = FRONT_WIDE - MARGIN * 2 - (across ? across + GAP : 0);

  const centred = (line: string, wide: number) =>
    MARGIN + Math.max(Math.floor((room - widthOf(line, wide)) / 2), 0);

  const parts = text.split(" - ");

  if (parts.length === 1 && widthOf(text, 2) <= room) {
    set(dots, text, centred(text, 2), middle, 2, 2);
  } else if (parts.length === 1 && widthOf(text, 1) <= room) {
    set(dots, text, centred(text, 1), middle, 1, 2);
  } else {
    const fits = Math.floor((room + 1) / (CHAR + 1));

    const lines =
      parts.length > 1
        ? [parts[0], parts.slice(1).join(" ")].map((line) =>
            line.slice(0, fits).trimEnd()
          )
        : twoLines(text.split(" "), fits);

    lines.forEach((line, k) => {
      set(dots, line, centred(line, 1), LINE_TOP + k * (TALL + LEADING), 1, 1);
    });
  }

  return dots;
}

/**
 * The signs of the buses drawn in detail, as one map of lamps: a band
 * BAND_WIDE × SIGN_ROWS for each different sign showing, `capacity` of
 * them, kept from frame to frame, the one longest out of sight given up
 * for a new one.
 */
export class BusSigns {
  /** The map: a byte a lamp, BAND_WIDE to a row, a band after a band. */
  readonly lamps: Uint8Array;

  /** Whether the lamps have changed since this was last set false. */
  changed = false;

  private bands = new Map<string, number>();
  private shows: (string | null)[];
  private seen: number[];
  private frame = 0;

  constructor(readonly capacity: number) {
    this.lamps = new Uint8Array(BAND_WIDE * SIGN_ROWS * capacity);
    this.shows = Array.from({ length: capacity }, () => null);
    this.seen = Array.from({ length: capacity }, () => -1);
  }

  /** A new frame: bands asked for from here on are in sight. */
  begin() {
    this.frame++;
  }

  /** The band showing `route` going to `destination`, set up if it's new. */
  bandFor(route: string, destination: string) {
    const key = `${route}\n${destination}`;
    let band = this.bands.get(key);

    if (band === undefined) {
      // The band longest out of sight.
      band = 0;

      for (let k = 1; k < this.capacity; k++) {
        if (this.seen[k] < this.seen[band]) band = k;
      }

      const old = this.shows[band];

      if (old !== null) this.bands.delete(old);
      this.bands.set(key, band);
      this.shows[band] = key;
      this.lamps.set(
        litBusSign(route, destination),
        band * BAND_WIDE * SIGN_ROWS
      );
      this.changed = true;
    }

    this.seen[band] = this.frame;

    return band;
  }
}
