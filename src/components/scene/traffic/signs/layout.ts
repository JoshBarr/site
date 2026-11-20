import { DOTS_HIGH, DOTS_WIDE } from "./dots";
import type { DirectionFace, Face, SignsFile, Structure } from "./file";

// Where each sign's steel and faces go, worked out from signs.json and the
// road: no drawing here. What the legends say and where the structures
// stand is data; their shapes and sizes below are guesses at the ordinary
// New Zealand ones.

/** A lamp's pitch on a message sign, m: characters 420 mm tall, or 210. */
const DOT = { large: 0.06, small: 0.03 };

/** The housing round a message sign's lamps, m. */
const BEZEL = { large: 0.18, small: 0.1 };

/**
 * A direction sign's capital height, m: over the road, on the verge where
 * the limit's 80 or more, and in town.
 */
const CAPITAL_OVERHEAD = 0.45;
const CAPITAL = 0.3;
const CAPITAL_TOWN = 0.2;
const FAST = 80 / 3.6;

/** A speed limit's disc, m across: where the limit's 80 or more, and under. */
const DISC = 1.2;
const DISC_TOWN = 0.9;

/** A direction panel's parts, in capital heights. */
const MARGIN = 0.8;
const LINE = 1.75;
const STREET = 0.72;
const ARROW = 2;
const GAP = 0.7;
const SHIELD_WIDE = 1.9;
const SHIELD_TALL = 2.1;

/** A letter's width, on average, in capital heights: bold sans, mixed case. */
export const LETTER = 0.82;

/** Under the lowest sign over the road, m; under a board on the verge. */
const CLEARANCE = 5.8;
const BOARD_FOOT = 2.3;
const SPEED_FOOT = 2;

/** A message sign's foot on a verge mast, m. */
const MESSAGE_FOOT = { large: 4.8, small: 3 };

/** Steel, m: a gantry's legs and beam, an arm's mast, a board's posts. */
const LEG = 0.5;
const BEAM_DEEP = 0.45;
const BEAM_TALL = 0.6;
const POST = 0.14;
const SPEED_POST = 0.09;
const MAST = { large: 0.4, small: 0.25 };

/** Posts and legs go this far into the ground, m: the verge isn't level. */
const BURIED = 1.5;

/** A face stands this far in front of what holds it, m; panels are this thick. */
const STAND_OFF = 0.34;
const THICK = 0.06;

/** Panels on one beam keep this far apart, m. */
const APART = 0.25;

/** What the layout needs to know of the road. */
export interface Ground {
  /** World x and z of an NZTM easting and northing. */
  toWorld(easting: number, northing: number): [number, number];
  /**
   * `s` m along carriageway `on`: the road's height, the way its traffic
   * runs (a unit x, z), and its limit, m/s. Null if there's no such road.
   */
  at(
    on: string,
    s: number
  ): { y: number; tx: number; tz: number; limit: number } | null;
}

/** A box of steel: its middle, the unit way its length runs (x, z), and its size. */
export interface Box {
  x: number;
  y: number;
  z: number;
  ux: number;
  uz: number;
  /** Along (ux, uz), up, and across. */
  size: [number, number, number];
}

/** A face, set up: its middle, the unit way it faces (x, z), and its size, m. */
export interface PlacedFace {
  face: Face;
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  width: number;
  height: number;
  /** A direction panel's capital height, m. */
  capital: number;
}

export interface PlacedStructure {
  id: string;
  /** Where it stands, for telling how far off it is. */
  x: number;
  y: number;
  z: number;
  boxes: Box[];
  faces: PlacedFace[];
}

/** A direction panel's parts, in m from its top left. */
export interface DirectionLayout {
  width: number;
  height: number;
  capital: number;
  /** Each line: its text, where its baseline starts, and its capital height. */
  text: { text: string; x: number; y: number; capital: number }[];
  /** Arrows: each one's middle, size, and which way it points. */
  arrows: { x: number; y: number; size: number; way: DirectionFace["arrow"] }[];
  /** State highway shields: each one's top left, size, and number. */
  shields: {
    x: number;
    y: number;
    width: number;
    height: number;
    number: string;
  }[];
}

/**
 * A direction panel, laid out: the arrow on the side it points (to the left
 * when ahead), shields before the destinations, the street under them,
 * smaller; over lanes, an arrow down for each along the bottom.
 */
export function layOutDirection(
  face: DirectionFace,
  capital: number
): DirectionLayout {
  const widest = Math.max(
    ...face.lines.map((line) => line.length * LETTER * capital),
    face.street ? face.street.length * LETTER * STREET * capital : 0
  );

  const shields = (face.refs ?? []).map((ref) => ref.replace(/^SH/, ""));
  const down = face.arrow === "down";
  const margin = MARGIN * capital;
  const arrow = down ? 0 : (ARROW + GAP) * capital;
  const shieldsWide = shields.length * (SHIELD_WIDE + GAP * 0.6) * capital;
  const lanes = Math.max(face.lanes ?? 1, 1);

  const width = Math.max(
    margin * 2 + arrow + shieldsWide + widest,
    down ? lanes * ARROW * 1.4 * capital + margin * 2 : 0
  );

  const textTall =
    face.lines.length * LINE * capital +
    (face.street ? LINE * STREET * capital : 0);

  const tall = Math.max(textTall, shields.length ? SHIELD_TALL * capital : 0);
  const height = margin * 2 + tall + (down ? (ARROW + GAP) * capital : 0);

  // The arrow's on the right for a right turn; all else starts after it.
  const left = margin + (face.arrow === "right" ? 0 : arrow);
  const textLeft = left + shieldsWide;
  const top = margin + (tall - textTall) / 2;

  const text = face.lines.map((line, k) => ({
    text: line,
    x: textLeft,
    y: top + k * LINE * capital + (LINE + 1) * 0.5 * capital,
    capital,
  }));

  if (face.street) {
    text.push({
      text: face.street,
      x: textLeft,
      y:
        top +
        face.lines.length * LINE * capital +
        (LINE * STREET + STREET) * 0.5 * capital,
      capital: STREET * capital,
    });
  }

  const arrows = down
    ? Array.from({ length: lanes }, (_, k) => ({
        x: (width * (k + 0.5)) / lanes,
        y: height - margin - (ARROW * capital) / 2,
        size: ARROW * capital,
        way: face.arrow,
      }))
    : [
        {
          x:
            face.arrow === "right"
              ? width - margin - (ARROW * capital) / 2
              : margin + (ARROW * capital) / 2,
          y: margin + tall / 2,
          size: ARROW * capital,
          way: face.arrow,
        },
      ];

  return {
    width,
    height,
    capital,
    text,
    arrows,
    shields: shields.map((number, k) => ({
      x: left + k * (SHIELD_WIDE + GAP * 0.6) * capital,
      y: margin + (tall - SHIELD_TALL * capital) / 2,
      width: SHIELD_WIDE * capital,
      height: SHIELD_TALL * capital,
      number,
    })),
  };
}

/**
 * A face's size, m, where the limit's `limit` m/s, `overhead` if it hangs
 * over the road; and a direction panel's capital height.
 */
export function faceSize(face: Face, limit: number, overhead = false) {
  if (face.kind === "vms") {
    return {
      width: DOTS_WIDE * DOT[face.size] + BEZEL[face.size] * 2,
      height: DOTS_HIGH * DOT[face.size] + BEZEL[face.size] * 2,
      capital: 0,
    };
  }

  if (face.kind === "speed") {
    const across = limit >= FAST ? DISC : DISC_TOWN;

    return { width: across, height: across, capital: 0 };
  }

  const capital = overhead
    ? CAPITAL_OVERHEAD
    : limit >= FAST
      ? CAPITAL
      : CAPITAL_TOWN;

  const { width, height } = layOutDirection(face, capital);

  return { width, height, capital };
}

/** Where a message sign's lamps are within its face: the housing's bezel, m. */
export const bezel = (size: "large" | "small") => BEZEL[size];

/** A post from the ground at `foot` up to `top`, `thick` square. */
const post = (
  x: number,
  z: number,
  foot: number,
  top: number,
  thick: number,
  ux: number,
  uz: number
): Box => ({
  x,
  y: (foot - BURIED + top) / 2,
  z,
  ux,
  uz,
  size: [thick, top - foot + BURIED, thick],
});

/**
 * Panels along a beam, each with its middle (m along) and width: moved
 * apart, as little as it takes, until none overlap. Returns their middles.
 */
export function spread(panels: { at: number; width: number }[]) {
  const order = panels
    .map((_, k) => k)
    .sort((a, b) => panels[a].at - panels[b].at);

  const at = panels.map((panel) => panel.at);

  // Overlapping neighbours move apart by halves, a few times over.
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;

    for (let k = 1; k < order.length; k++) {
      const [a, b] = [order[k - 1], order[k]];
      const need = (panels[a].width + panels[b].width) / 2 + APART;
      const short = need - (at[b] - at[a]);

      if (short > 1e-6) {
        at[a] -= short / 2;
        at[b] += short / 2;
        moved = true;
      }
    }

    if (!moved) break;
  }

  return at;
}

/** A structure's steel and faces, in the world; null if its road isn't there. */
export function place(
  structure: Structure,
  ground: Ground
): PlacedStructure | null {
  const base = ground.at(structure.on, structure.s);

  if (!base) return null;
  const [ax, az] = ground.toWorld(...structure.a);
  const [bx, bz] = ground.toWorld(...structure.b);
  const y = base.y;
  const boxes: Box[] = [];
  const faces: PlacedFace[] = [];

  const sized = structure.panels.flatMap((panel) => {
    const road = ground.at(panel.on, panel.s);

    return road
      ? [
          {
            panel,
            road,
            ...faceSize(panel.face, road.limit, structure.kind !== "post"),
          },
        ]
      : [];
  });

  if (!sized.length) return null;

  if (structure.kind === "post") {
    const [{ panel, road, width, height, capital }] = sized;
    const { face } = panel;
    // It faces the traffic coming: back along the road.
    const nx = -road.tx;
    const nz = -road.tz;
    // The viewer's right, along the board.
    const [rx, rz] = [nz, -nx];

    const foot =
      face.kind === "vms"
        ? MESSAGE_FOOT[face.size]
        : face.kind === "speed"
          ? SPEED_FOOT
          : BOARD_FOOT;

    const thick =
      face.kind === "vms"
        ? MAST[face.size]
        : face.kind === "speed"
          ? SPEED_POST
          : POST;

    // One post under a narrow board, two under a wide one.
    const posts =
      width > 1.8 && !(face.kind === "vms" && face.size === "small")
        ? [-0.3, 0.3]
        : [0];

    for (const across of posts) {
      boxes.push(
        post(
          ax + rx * width * across,
          az + rz * width * across,
          y,
          y + foot + height * (face.kind === "speed" ? 0.5 : 0.9),
          thick,
          rx,
          rz
        )
      );
    }

    faces.push({
      face,
      x: ax + nx * (thick / 2 + THICK),
      y: y + foot + height / 2,
      z: az + nz * (thick / 2 + THICK),
      nx,
      nz,
      width,
      height,
      capital,
    });

    return { id: structure.id, x: ax, y, z: az, boxes, faces };
  }

  // A beam from a to b, at a height that clears the road under its panels.
  const span = Math.hypot(bx - ax, bz - az) || 1;
  const [ux, uz] = [(bx - ax) / span, (bz - az) / span];
  const tallest = Math.max(...sized.map(({ height }) => height));
  const beam = y + Math.max(CLEARANCE + tallest / 2, CLEARANCE + BEAM_TALL);

  // Each carriageway's panels along the beam: direction panels moved apart
  // where they'd overlap, and a message sign that would cover one raised
  // over it.
  const roads = [...new Set(sized.map(({ panel }) => panel.on))];
  let from = 0;
  let to = span;

  for (const on of roads) {
    const here = sized.filter(({ panel }) => panel.on === on);
    const boards = here.filter(({ panel }) => panel.face.kind !== "vms");

    const middles = spread(
      boards.map(({ panel, width }) => ({ at: panel.t * span, width }))
    );

    const set = boards.map((board, k) => ({ ...board, at: middles[k], up: 0 }));

    for (const sign of here.filter(({ panel }) => panel.face.kind === "vms")) {
      const at = sign.panel.t * span;

      const under = set.filter(
        (board) =>
          Math.abs(board.at - at) < (board.width + sign.width) / 2 + APART
      );

      const up = under.length
        ? Math.max(...under.map(({ height }) => height)) / 2 +
          sign.height / 2 +
          APART
        : 0;

      set.push({ ...sign, at, up });
    }

    for (const { panel, road, width, height, capital, at, up } of set) {
      // Square to the beam, on the side the traffic comes from.
      const facing = -uz * road.tx + ux * road.tz < 0 ? 1 : -1;
      const [nx, nz] = [-uz * facing, ux * facing];

      faces.push({
        face: panel.face,
        x: ax + ux * at + nx * STAND_OFF,
        y: beam + up,
        z: az + uz * at + nz * STAND_OFF,
        nx,
        nz,
        width,
        height,
        capital,
      });
      from = Math.min(from, at - width / 2);
      to = Math.max(to, at + width / 2);

      if (up) {
        // Struts up from the beam to a sign raised over it.
        for (const across of [-0.3, 0.3]) {
          boxes.push({
            x: ax + ux * (at + width * across),
            y: beam + up / 2,
            z: az + uz * (at + width * across),
            ux,
            uz,
            size: [POST, up, POST],
          });
        }
      }
    }
  }

  // An arm reaches as far as its panels; a gantry's beam, leg to leg.
  const [start, end] = structure.kind === "gantry" ? [0, span] : [0, to];

  boxes.push({
    x: ax + (ux * (start + end)) / 2,
    y: beam,
    z: az + (uz * (start + end)) / 2,
    ux,
    uz,
    size: [end - start, BEAM_TALL, BEAM_DEEP],
  });
  boxes.push(post(ax, az, y, beam + BEAM_TALL / 2, LEG, ux, uz));

  if (structure.kind === "gantry") {
    boxes.push(post(bx, bz, y, beam + BEAM_TALL / 2, LEG, ux, uz));
  }

  return {
    id: structure.id,
    x: (ax + bx) / 2,
    y,
    z: (az + bz) / 2,
    boxes,
    faces,
  };
}

/** Every structure of `file` that's on a road `ground` knows. */
export const placeAll = (file: SignsFile, ground: Ground) =>
  file.structures.flatMap((structure) => place(structure, ground) ?? []);

/** A rectangle to find room for, in pixels. */
export interface Slot {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Room for rectangles of `sizes` (pixels) in a sheet `wide` across, a shelf
 * at a time, tallest first: where each goes, in the order given, and how
 * tall the sheet has to be.
 */
export function pack(sizes: { width: number; height: number }[], wide: number) {
  const order = sizes
    .map((_, k) => k)
    .sort((a, b) => sizes[b].height - sizes[a].height);

  const slots: Slot[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;

  for (const k of order) {
    const { width, height } = sizes[k];

    if (x + width > wide && x > 0) {
      x = 0;
      y += shelf;
      shelf = 0;
    }

    slots[k] = { x, y, width, height };
    x += width;
    shelf = Math.max(shelf, height);
  }

  return { slots, height: y + shelf };
}
