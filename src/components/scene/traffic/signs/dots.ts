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
