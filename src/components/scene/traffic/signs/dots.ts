import { PAGE_LINES, type SignPage } from "../../../../lib/signs";

// A message sign's face as its lamps: every sign's drawn as one grid of
// dots, with its message set on it in the 5 × 7 characters such signs use.
// NZTA says what a sign shows, not how many lamps it has, so the grid's
// sized for the longest messages they carry (four lines of twenty).

/** A character, and the gap after it, in dots. */
const CHAR = 5;
const PITCH = CHAR + 1;
const TALL = 7;

/** Characters a line holds, and lines a page. */
const COLUMNS = 20;
const ROWS = PAGE_LINES;

/** Dots dark round the edge. */
const MARGIN = 2;

/** Dots between lines: four lines are set tighter than fewer. */
const LEADING = 4;
const LEADING_TIGHT = 2;

/** The grid, in dots. */
export const DOTS_WIDE = COLUMNS * PITCH - 1 + MARGIN * 2;
export const DOTS_HIGH = ROWS * TALL + (ROWS - 1) * LEADING_TIGHT + MARGIN * 2;

/** Each character's rows, top to bottom. */
const GLYPHS = new Map(
  Object.entries({
    A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
    H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
    J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
    K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
    N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
    O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
    R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
    X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
    Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
    Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
    0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
    1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
    3: ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
    4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
    5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    6: ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
    7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
    8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    9: [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
    "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
    "'": ["..#..", "..#..", ".....", ".....", ".....", ".....", "....."],
    "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
    ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
    "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
    "/": [".....", "....#", "...#.", "..#..", ".#...", "#....", "....."],
    ":": [".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."],
    ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
    ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
    "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
    "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
    "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
    "%": ["##...", "##..#", "...#.", "..#..", ".#...", "#..##", "...##"],
  })
);

/**
 * A page as lit dots, DOTS_WIDE × DOTS_HIGH, a row at a time from the top:
 * 255 lit, 0 dark. Lines are centred up and down; each has its left text
 * from the left edge, its right to the right, the rest centred. What
 * doesn't fit the grid is cut: lines past the fourth, characters past the
 * twentieth (left text first, to keep a travel time's minutes).
 */
export function litDots(page: SignPage): Uint8Array {
  const dots = new Uint8Array(DOTS_WIDE * DOTS_HIGH);
  const lines = page.slice(0, ROWS);
  const leading = lines.length === ROWS ? LEADING_TIGHT : LEADING;
  const tall = lines.length * TALL + (lines.length - 1) * leading;
  const top = Math.floor((DOTS_HIGH - tall) / 2);

  const set = (text: string, column: number, y: number) => {
    [...text.toUpperCase()].forEach((character, k) => {
      const glyph = GLYPHS.get(character);

      if (!glyph) return;
      const x = MARGIN + (column + k) * PITCH;

      glyph.forEach((row, j) => {
        for (let i = 0; i < CHAR; i++) {
          if (row[i] === "#") dots[(y + j) * DOTS_WIDE + x + i] = 255;
        }
      });
    });
  };

  lines.forEach((line, row) => {
    const y = top + row * (TALL + leading);
    const right = line.right.slice(-COLUMNS);
    const room = COLUMNS - right.length - (right ? 1 : 0);
    const left = line.left.slice(0, Math.max(room, 0));
    const centre = line.centre.slice(0, COLUMNS);

    set(left, 0, y);
    set(right, COLUMNS - right.length, y);
    set(centre, Math.floor((COLUMNS - centre.length) / 2), y);
  });

  return dots;
}

/** A lane sign's ring, in dots from its middle: inside and outside. */
const RING = [15.5, 18.6];

/** Its number's height, and the most room across for it, in dots. */
const NUMBER_TALL = TALL * 2;
const NUMBER_WIDE = 22;
const NUMBER_GAP = 2;

/**
 * A lane sign showing a speed limit, as lit dots in the same grid as a
 * message sign's page (DOTS_WIDE × DOTS_HIGH), in the DOTS_HIGH square at
 * its left: a
 * ring, and the limit inside it, its characters twice their usual size, or
 * narrower where three wouldn't fit. Dark for null.
 */
export function litLane(limit: number | null): Uint8Array {
  const dots = new Uint8Array(DOTS_WIDE * DOTS_HIGH);

  if (limit === null) return dots;
  const middle = DOTS_HIGH / 2;

  for (let y = 0; y < DOTS_HIGH; y++) {
    for (let x = 0; x < DOTS_HIGH; x++) {
      const r = Math.hypot(x + 0.5 - middle, y + 0.5 - middle);

      if (r >= RING[0] && r <= RING[1]) dots[y * DOTS_WIDE + x] = 255;
    }
  }

  // Each character's lit columns only: a "1" is narrow.
  const glyphs = [...String(limit)].flatMap((character) => {
    const glyph = GLYPHS.get(character);

    if (!glyph) return [];

    const used = [...Array(CHAR).keys()].filter((i) =>
      glyph.some((row) => row[i] === "#")
    );

    return [{ glyph, from: used[0] ?? 0, wide: used.length || 1 }];
  });

  const gaps = (glyphs.length - 1) * NUMBER_GAP;
  const columns = glyphs.reduce((sum, { wide }) => sum + wide, 0);
  const scale = Math.min(2, (NUMBER_WIDE - gaps) / columns);
  const across = columns * scale + gaps;
  let left = Math.round(middle - across / 2);
  const top = Math.round(middle - NUMBER_TALL / 2);

  for (const { glyph, from, wide } of glyphs) {
    const width = Math.round(wide * scale);

    for (let y = 0; y < NUMBER_TALL; y++) {
      const row = glyph[Math.floor((y / NUMBER_TALL) * TALL)];

      for (let x = 0; x < width; x++) {
        if (row[from + Math.floor((x / width) * wide)] === "#") {
          dots[(top + y) * DOTS_WIDE + left + x] = 255;
        }
      }
    }

    left += width + NUMBER_GAP;
  }

  return dots;
}
