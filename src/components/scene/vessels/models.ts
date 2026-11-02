import { random } from "../landmarks/common";
import { ModelBuilder, Vec, WINDOW_GLOW } from "../models/builder";

// Detailed ships, for the few close enough to see: each built to its own
// length and beam, bow toward -z, x to starboard, waterline at y = 0. A ship's
// kind picks its design; the harbour's regulars, the Cook Strait ferries,
// have their own. Greys only, as the rest of the scene.
//
// The ferries are drawn from memory of photos, not plans: the Visentini-built
// ro-paxes (Kaiārahi, Connemara, Livia) with their accommodation forward,
// open trailer deck aft and paired funnels; Kaitaki as a cruise ferry,
// superstructure most of her length and one big funnel.

export type Kind =
  | "passenger"
  | "cargo"
  | "tanker"
  | "tug"
  | "pilot"
  | "sailing"
  | "pleasure"
  | "fishing"
  | "other";

export type Point = [number, number, number];

/** Where a ship's lights are: metres in its frame, x starboard, z aft. */
export interface Lights {
  masthead: Point;
  port: Point;
  starboard: Point;
  stern: Point;
  anchor: Point;
}

export interface ShipSpec {
  mmsi: number;
  name: string | null;
  kind: Kind;
  length: number;
  beam: number;
  /** Deck height above the water. */
  freeboard: number;
  /** Where its AIS antenna is, 0 at the bow to 1 at the stern, if known. */
  antenna: number | null;
}

/** Between decks, m. */
const DECK = 2.8;

const WHITE = 0xf2f2f2;
const OFF_WHITE = 0xdcdcdc;
const ANTIFOUL = 0x3a3434;
const DARK = 0x1f1f1f;
const GLASS = 0x1c2124;
const STEEL = 0x6a6a6a;
const DECK_GREY = 0x8a8a8a;

/** Containers and trailers, light to dark. */
const BOXES = [0x9a9a9a, 0x7a7a7a, 0x5c5c5c, 0x8a8a8a, 0xb4b4b4, 0x4a4a4a];

const clamp = (x: number, low: number, high: number) =>
  Math.min(Math.max(x, low), high);

/** 0 at u = 0 rising to 1 at u = 1: how a waterline or deck fills out. */
const ease = (u: number, power: number) =>
  u >= 1 ? 1 : u <= 0 ? 0 : Math.sin((u * Math.PI) / 2) ** power;

// --- Hulls. ---

interface HullSpec {
  length: number;
  beam: number;
  freeboard: number;
  draft: number;
  /** Of the length, over which the bow narrows to its stem. */
  entry: number;
  /** Of the length, over which the stern narrows to its transom. */
  run: number;
  /** The transom's width, of the beam. */
  transom: number;
  /** How far the stem leans forward of where it meets the water, m. */
  rake: number;
  /** How much higher the deck is at the bow, m. */
  sheer: number;
  /** Centre across, m: a catamaran's hulls are off it. */
  x?: number;
  sides: number;
  deck: number;
  /** Topsides above this height, m, are `topsides`. */
  band?: [number, number];
}

/** Stations along the hull, 0 at the bow: closer where its lines curve. */
const STATIONS = [
  0, 0.01, 0.025, 0.045, 0.07, 0.1, 0.14, 0.19, 0.25, 0.32, 0.4, 0.5, 0.6, 0.7,
  0.78, 0.85, 0.9, 0.94, 0.97, 0.99, 1,
];

/**
 * A hull: raked stem, fine entry, flat run aft to a transom, the deck rising
 * to the bow; painted below the waterline, up the sides, and on deck.
 * Returns its starboard deck edge, bow to stern.
 */
function hull(b: ModelBuilder, h: HullSpec): Vec[] {
  const { length: L, freeboard, draft, x = 0 } = h;
  const half = h.beam / 2;
  const least = Math.min(0.02 * half, 0.05);
  const entry = h.entry * L;

  const stations = STATIONS.map((u) => {
    const t = u * L;
    const aft = h.transom + (1 - h.transom) * ease((L - t) / (h.run * L), 0.6);

    return {
      z: -L / 2 + t,
      deck: Math.max(half * ease(t / entry, 0.6) * aft, least),
      water: Math.max(
        half * 0.96 * ease((t - h.rake) / (entry - h.rake), 0.75) * aft,
        least
      ),
      y: freeboard + h.sheer * Math.max(0, 1 - t / (0.35 * L)) ** 2,
      depth: draft * (0.5 + 0.5 * ease(t / entry, 1)),
    };
  });

  type Station = (typeof stations)[number];

  const across = (s: Station, y: number) =>
    s.water + (s.deck - s.water) * Math.min(y / s.y, 1);

  const side = (y0: number, y1: (s: Station) => number) =>
    stations.map((s): Vec[] => [
      [x + across(s, y1(s)), y1(s), s.z],
      [x + across(s, y0), y0, s.z],
      [x - across(s, y0), y0, s.z],
      [x - across(s, y1(s)), y1(s), s.z],
    ]);

  const open = { ring: false };

  if (h.band) {
    const [from, color] = h.band;
    b.use(h.sides).loft(
      side(0, () => from),
      open
    );
    b.use(color).loft(
      side(from, (s) => s.y),
      open
    );
  } else {
    b.use(h.sides).loft(
      side(0, (s) => s.y),
      open
    );
  }

  b.use(ANTIFOUL).loft(
    stations.map((s): Vec[] => [
      [x + s.water, 0, s.z],
      [x + s.water * 0.85, -0.6 * s.depth, s.z],
      [x, -s.depth, s.z],
      [x - s.water * 0.85, -0.6 * s.depth, s.z],
      [x - s.water, 0, s.z],
    ])
  );

  b.use(h.deck);

  for (let i = 0; i < stations.length - 1; i++) {
    const [s, t] = [stations[i], stations[i + 1]];
    b.quad(
      [x, Math.min(s.y, t.y) - 1, (s.z + t.z) / 2],
      [x - s.deck, s.y, s.z],
      [x + s.deck, s.y, s.z],
      [x + t.deck, t.y, t.z],
      [x - t.deck, t.y, t.z]
    );
  }

  return stations.map((s): Vec => [x + s.deck, s.y, s.z]);
}

// --- Superstructure. ---

interface Windows {
  /** Bottom and top, m above the house's floor. */
  from: number;
  to: number;
  pitch: number;
  width: number;
  /** Lit at night: cabins, not bridges. */
  lit?: boolean;
  front?: boolean;
  sides?: boolean;
  back?: boolean;
}

interface House {
  /** Front, toward the bow, and back, m along. */
  z0: number;
  z1: number;
  y0: number;
  y1: number;
  half: number;
  /** The front's top is set back this far, m. */
  rake?: number;
  /** The top's this much wider each side, m: a tug's wheelhouse. */
  flare?: number;
  x?: number;
  color: number;
  windows?: Windows[];
}

/** A deckhouse with rows of windows round it. */
function house(b: ModelBuilder, h: House) {
  const { z0, z1, y0, y1, half, rake = 0, flare = 0, x = 0 } = h;

  const rect = (y: number, w: number, front: number): Vec[] => [
    [x + w, y, front],
    [x + w, y, z1],
    [x - w, y, z1],
    [x - w, y, front],
  ];

  b.use(h.color).loft([rect(y0, half, z0), rect(y1, half + flare, z0 + rake)]);

  const up = (y: number) => (y - y0) / (y1 - y0);
  const width = (y: number) => half + flare * up(y);
  const front = (y: number) => z0 + rake * up(y);
  const inside: Vec = [x, (y0 + y1) / 2, (z0 + z1) / 2];
  const proud = 0.03;

  /** Evenly spaced panes across a span, centred in it. */
  const panes = (from: number, to: number, pitch: number, size: number) => {
    const span = to - from;
    const n = Math.floor((span + pitch - size) / pitch);
    const start = from + (span - (n - 1) * pitch - size) / 2;

    return Array.from({ length: Math.max(n, 0) }, (_, i) => start + i * pitch);
  };

  for (const w of h.windows ?? []) {
    const [a, c] = [y0 + w.from, y0 + w.to];
    b.use(GLASS, w.lit ? WINDOW_GLOW : 0);

    if (w.sides !== false) {
      const from = Math.max(front(a), front(c)) + 0.3;

      for (const z of panes(from, z1 - 0.3, w.pitch, w.width)) {
        for (const sign of [-1, 1]) {
          const at = (y: number) => x + sign * (width(y) + proud);
          b.quad(
            inside,
            [at(a), a, z],
            [at(a), a, z + w.width],
            [at(c), c, z + w.width],
            [at(c), c, z]
          );
        }
      }
    }

    const ends: [boolean | undefined, (y: number) => number][] = [
      [w.front, (y) => front(y) - proud],
      [w.back, () => z1 + proud],
    ];

    for (const [shown, at] of ends) {
      if (!shown) continue;
      const room = Math.min(width(a), width(c)) - 0.3;

      for (const u of panes(-room, room, w.pitch, w.width)) {
        b.quad(
          inside,
          [x + u, a, at(a)],
          [x + u + w.width, a, at(a)],
          [x + u + w.width, c, at(c)],
          [x + u, c, at(c)]
        );
      }
    }
  }
}

/** A funnel, rounded in plan, raked aft, with a dark top. */
function funnel(
  b: ModelBuilder,
  [x, y0, z]: Vec,
  height: number,
  long: number,
  wide: number,
  color: number
) {
  const rake = height * 0.2;

  const section = (y: number): Vec[] => {
    const shift = (rake * (y - y0)) / height;
    const c = Math.min(long, wide) * 0.45;

    return [
      [x + wide, y, z + shift - long + c],
      [x + wide, y, z + shift + long - c],
      [x + wide - c, y, z + shift + long],
      [x - wide + c, y, z + shift + long],
      [x - wide, y, z + shift + long - c],
      [x - wide, y, z + shift - long + c],
      [x - wide + c, y, z + shift - long],
      [x + wide - c, y, z + shift - long],
    ];
  };

  const top = y0 + height;
  const band = Math.min(1.5, height * 0.15);
  b.use(color).loft([section(y0), section(top - band)]);
  b.use(DARK).loft([section(top - band), section(top)]);
}

/** A mast from `foot`, with a yard for its radar. Returns its top. */
function mast(b: ModelBuilder, foot: Vec, height: number, yard: number): Vec {
  const [x, y, z] = foot;
  const top: Vec = [x, y + height, z];
  const r = clamp(height * 0.02, 0.04, 0.3);
  b.use(OFF_WHITE).cylinder(foot, top, r);

  if (yard > 0) {
    const at = y + height * 0.75;
    b.box([x - yard, at - r, z - r], [x + yard, at + r, z + r]);
  }

  return top;
}

/** A row of boats or rafts in davits, along the side at `y`. */
function lifeboats(
  b: ModelBuilder,
  x: number,
  y: number,
  from: number,
  to: number,
  count: number
) {
  const length = clamp((to - from) / count - 2, 4, 9);
  const r = length * 0.17;
  b.use(OFF_WHITE);

  for (let i = 0; i < count; i++) {
    const z = from + ((i + 0.5) * (to - from)) / count;

    for (const sign of [-1, 1]) {
      b.tube(
        [
          [z - length / 2, r * 0.3, y + r, r * 0.3],
          [z - length * 0.35, r, y + r, r],
          [z + length * 0.4, r, y + r, r],
          [z + length / 2, r * 0.6, y + r, r * 0.6],
        ],
        sign * x
      );
    }
  }
}

/** Rubber fendering along the deck edge, both sides. */
function fender(b: ModelBuilder, edge: Vec[], radius: number) {
  b.use(DARK);

  for (const sign of [-1, 1]) {
    for (let i = 1; i < edge.length - 1; i++) {
      const [ax, ay, az] = edge[i];
      const [bx, by, bz] = edge[i + 1];
      b.cylinder(
        [sign * ax, ay - radius, az],
        [sign * bx, by - radius, bz],
        radius
      );
    }
  }
}

// --- Designs. ---

interface Liner {
  /** Decks of superstructure above the main deck. */
  decks: number;
  /** Superstructure from and to, of the length from the bow. */
  from: number;
  to: number;
  /** Upper decks end this much further forward each, of the length. */
  terrace: number;
  /** The bridge's front, of the length from the bow. */
  bridge: number;
  funnel: {
    at: number;
    pair: boolean;
    long: number;
    wide: number;
    height: number;
  };
  /** Whether the upper hull's white. */
  band: boolean;
  /** Trailers on an open deck aft of the superstructure. */
  trailers: boolean;
}

/** A ferry or cruise ship: decks of cabins and lounges, bridge forward. */
function liner(b: ModelBuilder, s: ShipSpec, o: Liner): Lights {
  const { length: L, beam: B, freeboard: fb } = s;
  const along = (f: number) => -L / 2 + f * L;
  b.sides = 8;

  hull(b, {
    length: L,
    beam: B,
    freeboard: fb,
    draft: clamp(L * 0.035, 1, 7),
    entry: 0.24,
    run: 0.14,
    transom: 0.82,
    rake: L * 0.035,
    sheer: fb * 0.15,
    sides: 0x2c3036,
    deck: DECK_GREY,
    band: o.band ? [fb * 0.55, WHITE] : undefined,
  });

  for (let k = 0; k < o.decks; k++) {
    house(b, {
      z0: along(o.from + 0.004 * k),
      z1: along(o.to - o.terrace * k),
      y0: fb + k * DECK,
      y1: fb + (k + 1) * DECK,
      half: (B / 2) * (k < 2 ? 0.98 : 0.92),
      rake: 0.5,
      color: WHITE,
      windows: [
        {
          from: 0.9,
          to: 1.9,
          pitch: 1.8,
          width: 1.3,
          lit: true,
          front: k >= o.decks - 2,
          back: true,
        },
      ],
    });
  }

  // The bridge on top, its wings out to the ship's sides.
  const top = fb + o.decks * DECK;
  const front = along(o.bridge);
  const bridge = { from: 0.9, to: 2.1, pitch: 1.3, width: 1.15 };
  house(b, {
    z0: front,
    z1: front + Math.max(12, L * 0.08),
    y0: top,
    y1: top + DECK,
    half: (B / 2) * 0.8,
    rake: 0.8,
    color: WHITE,
    windows: [{ ...bridge, front: true }],
  });
  house(b, {
    z0: front + 0.5,
    z1: front + 4,
    y0: top,
    y1: top + DECK - 0.3,
    half: B / 2,
    color: WHITE,
    windows: [{ ...bridge, front: true, sides: false }],
  });

  const masthead = mast(b, [0, top + DECK, front + 5], 9, 2.5);
  const { at, pair, long, wide, height } = o.funnel;
  const base = fb + (o.decks - 1) * DECK;

  for (const x of pair ? [-B * 0.22, B * 0.22] : [0]) {
    funnel(b, [x, base, along(at)], height + DECK, long, wide, 0x3a3d42);
  }

  lifeboats(
    b,
    B / 2 - 1.6,
    fb + DECK,
    along(o.from + 0.12),
    along(o.to - 0.12),
    clamp(Math.round(L / 40), 2, 6)
  );

  if (o.trailers) {
    // Bulwarks along an open deck, and lanes of trailers on it.
    const [z0, z1] = [along(o.to) + 2, L / 2 - 6];
    b.use(0x2c3036);

    for (const sign of [-1, 1]) {
      b.box(
        [sign * (B / 2 - 0.3), fb, z0],
        [sign * (B / 2 - 0.05), fb + 1.4, L / 2 - 1]
      );
    }

    const lanes = Math.floor((B - 2) / 3.1);
    const rows = Math.floor((z1 - z0) / 14.4);

    for (let lane = 0; lane < lanes; lane++) {
      const x = (lane - (lanes - 1) / 2) * 3.1;

      for (let row = 0; row < rows; row++) {
        const seed = s.mmsi + lane * 31 + row * 7;

        if (random(seed) > 0.65) continue;
        const z = z0 + row * 14.4;
        b.use(BOXES[Math.floor(random(seed + 1) * BOXES.length)]);
        b.box([x - 1.25, fb + 1, z], [x + 1.25, fb + 4, z + 13.6]);
      }
    }
  }

  // The stern door.
  b.use(DARK).box(
    [-B * 0.3, 0.8, L / 2 - 0.1],
    [B * 0.3, fb - 0.6, L / 2 + 0.05]
  );

  return {
    masthead,
    port: [-B / 2, top + 1.5, front + 1.5],
    starboard: [B / 2, top + 1.5, front + 1.5],
    stern: [0, fb + 1.5, L / 2],
    anchor: masthead,
  };
}

const kaitaki = (b: ModelBuilder, s: ShipSpec) =>
  liner(b, s, {
    decks: 5,
    from: 0.1,
    to: 0.8,
    terrace: 0.035,
    bridge: 0.1,
    funnel: { at: 0.64, pair: false, long: 7, wide: 4, height: 9 },
    band: true,
    trailers: false,
  });

const visentini = (band: boolean) => (b: ModelBuilder, s: ShipSpec) =>
  liner(b, s, {
    decks: 4,
    from: 0.12,
    to: 0.52,
    terrace: 0.02,
    bridge: 0.12,
    funnel: { at: 0.47, pair: true, long: 3.5, wide: 1.6, height: 8 },
    band,
    trailers: true,
  });

/** A big passenger ship we don't know: a cruise ship's layers of decks. */
const cruise = (b: ModelBuilder, s: ShipSpec) =>
  liner(b, s, {
    decks: clamp(Math.round(s.length / 28), 3, 12),
    from: 0.12,
    to: 0.86,
    terrace: 0.015,
    bridge: 0.1,
    funnel: {
      at: 0.74,
      pair: false,
      long: s.length * 0.04,
      wide: s.beam * 0.2,
      height: 10,
    },
    band: true,
    trailers: false,
  });

/** A harbour ferry: two slim hulls, a glassy cabin, wheelhouse on top. */
function catamaran(b: ModelBuilder, s: ShipSpec): Lights {
  const { length: L, beam: B } = s;
  const fb = Math.max(1.2, L * 0.07);
  const w = B * 0.3;
  b.sides = 8;

  for (const sign of [-1, 1]) {
    hull(b, {
      length: L,
      beam: w,
      freeboard: fb,
      draft: 0.9,
      entry: 0.45,
      run: 0.1,
      transom: 0.85,
      rake: L * 0.04,
      sheer: 0.3,
      x: sign * (B / 2 - w / 2),
      sides: WHITE,
      deck: DECK_GREY,
    });
  }

  b.use(WHITE).box(
    [-B / 2 + w * 0.4, fb - 0.5, -L / 2 + L * 0.1],
    [B / 2 - w * 0.4, fb, L / 2 - L * 0.02]
  );

  const cabin = 2.3;
  house(b, {
    z0: -L / 2 + L * 0.17,
    z1: L / 2 - L * 0.2,
    y0: fb,
    y1: fb + cabin,
    half: (B / 2) * 0.96,
    rake: 0.8,
    color: WHITE,
    windows: [
      {
        from: 0.85,
        to: 2,
        pitch: 1.3,
        width: 1.15,
        lit: true,
        front: true,
        back: true,
      },
    ],
  });

  const front = -L / 2 + L * 0.22;
  house(b, {
    z0: front,
    z1: -L / 2 + L * 0.42,
    y0: fb + cabin,
    y1: fb + cabin + 1.8,
    half: (B / 2) * 0.55,
    rake: 0.5,
    color: WHITE,
    windows: [{ from: 0.7, to: 1.55, pitch: 0.9, width: 0.8, front: true }],
  });

  // Rails round the open top deck.
  b.use(OFF_WHITE);
  const rail = fb + cabin + 1;

  for (const sign of [-1, 1]) {
    b.box(
      [sign * (B / 2) * 0.96 - 0.03, rail, -L / 2 + L * 0.42],
      [sign * (B / 2) * 0.96 + 0.03, rail + 0.06, L / 2 - L * 0.2]
    );
  }

  const masthead = mast(b, [0, fb + cabin + 1.8, front + 1.5], 2.5, 0.6);

  return {
    masthead,
    port: [-B / 2, fb + cabin + 1.2, front],
    starboard: [B / 2, fb + cabin + 1.2, front],
    stern: [0, fb + 0.6, L / 2],
    anchor: masthead,
  };
}

/** A harbour tug: high bow, fendered, a flared wheelhouse with all-round glass. */
function tug(b: ModelBuilder, s: ShipSpec): Lights {
  const { length: L, beam: B, freeboard: fb } = s;
  b.sides = 6;

  const edge = hull(b, {
    length: L,
    beam: B,
    freeboard: fb,
    draft: fb * 1.4,
    entry: 0.45,
    run: 0.25,
    transom: 0.7,
    rake: L * 0.03,
    sheer: fb * 0.6,
    sides: 0x1f1f1f,
    deck: STEEL,
  });

  fender(b, edge, clamp(B * 0.035, 0.2, 0.45));

  const house1 = 2.4;
  const front = -L / 2 + L * 0.2;
  house(b, {
    z0: front,
    z1: -L / 2 + L * 0.56,
    y0: fb,
    y1: fb + house1,
    half: (B / 2) * 0.7,
    color: WHITE,
    windows: [{ from: 1, to: 1.7, pitch: 1.6, width: 0.7, lit: true }],
  });
  house(b, {
    z0: front + 0.6,
    z1: -L / 2 + L * 0.45,
    y0: fb + house1,
    y1: fb + house1 + 2.3,
    half: (B / 2) * 0.5,
    flare: 0.35,
    rake: -0.35,
    color: WHITE,
    windows: [
      {
        from: 0.8,
        to: 2.1,
        pitch: 1.05,
        width: 0.95,
        front: true,
        back: true,
      },
    ],
  });

  const masthead = mast(b, [0, fb + house1 + 2.3, front + 2.5], 4.5, 1.2);

  // Towing winch aft, and a bitt.
  b.use(STEEL).box([-1.2, fb, L * 0.12], [1.2, fb + 1.4, L * 0.12 + 2]);
  b.cylinder([0, fb, L / 2 - 2.5], [0, fb + 1, L / 2 - 2.5], 0.35);

  return {
    masthead,
    port: [-(B / 2) * 0.7, fb + house1 + 1, front + 1],
    starboard: [(B / 2) * 0.7, fb + house1 + 1, front + 1],
    stern: [0, fb + 0.8, L / 2],
    anchor: masthead,
  };
}

/** A pilot launch: fast hull, a cabin amidships, its own colours. */
function pilot(b: ModelBuilder, s: ShipSpec): Lights {
  const { length: L, beam: B, freeboard: fb } = s;
  b.sides = 6;

  const edge = hull(b, {
    length: L,
    beam: B,
    freeboard: fb,
    draft: fb * 0.8,
    entry: 0.42,
    run: 0.1,
    transom: 0.9,
    rake: L * 0.05,
    sheer: fb * 0.4,
    sides: 0x2b2b2b,
    deck: STEEL,
  });

  fender(b, edge, 0.15);
  const front = -L / 2 + L * 0.25;
  const height = 2;
  house(b, {
    z0: front,
    z1: -L / 2 + L * 0.64,
    y0: fb,
    y1: fb + height,
    half: (B / 2) * 0.78,
    rake: 0.9,
    color: 0xcfcfcf,
    windows: [
      {
        from: 0.9,
        to: 1.7,
        pitch: 1,
        width: 0.85,
        lit: true,
        front: true,
      },
    ],
  });

  const masthead = mast(b, [0, fb + height, front + 2], 2.5, 0.6);

  return {
    masthead,
    port: [-(B / 2) * 0.78, fb + 1.6, front + 0.5],
    starboard: [(B / 2) * 0.78, fb + 1.6, front + 0.5],
    stern: [0, fb + 0.5, L / 2],
    anchor: masthead,
  };
}

/** Container lines by the names they give their ships. */
const CONTAINER_LINES =
  /^(MSC|MAERSK|CMA CGM|APL|ANL|HAPAG|ONE |COSCO|OOCL|EVER|KOTA|SPIL|CSCL|ZIM|HMM|YM |SEASPAN|NORTHERN|SANTA|SAN )/;

/**
 * A ship with its accommodation and funnel aft, where its antenna is, and
 * forward of it containers, hatches and cranes, or a tanker's pipework.
 */
function merchant(b: ModelBuilder, s: ShipSpec): Lights {
  const { length: L, beam: B, freeboard: fb } = s;
  b.sides = 8;

  const containers =
    s.kind === "cargo" && CONTAINER_LINES.test(s.name?.toUpperCase() ?? "");

  hull(b, {
    length: L,
    beam: B,
    freeboard: fb,
    draft: clamp(L * 0.05, 2, 12),
    entry: 0.2,
    run: 0.14,
    transom: 0.75,
    rake: L * 0.025,
    sheer: fb * 0.25,
    sides: s.kind === "tanker" ? 0x2a2a2a : 0x383838,
    deck: s.kind === "tanker" ? 0x6a6a6a : 0x5e5e5e,
  });

  // The bridge where the antenna is; it's mostly on top of it.
  const antenna = clamp(s.antenna ?? 0.85, 0.55, 0.92);
  const front = -L / 2 + antenna * L - 5;
  const back = Math.min(front + Math.max(L * 0.08, 10), L / 2 - 3);
  const height = clamp(L * 0.12, 8, 34);
  const decks = Math.max(Math.floor(height / DECK) - 1, 1);

  for (let k = 0; k < decks; k++) {
    house(b, {
      z0: front,
      z1: back,
      y0: fb + k * DECK,
      y1: fb + (k + 1) * DECK,
      half: (B / 2) * (k === decks - 1 ? 1 : 0.8),
      color: WHITE,
      windows: [
        {
          from: 0.9,
          to: 1.8,
          pitch: k === decks - 1 ? 1.4 : 2.6,
          width: 1.1,
          lit: k < decks - 1,
          front: true,
          back: true,
        },
      ],
    });
  }

  const top = fb + decks * DECK;
  const masthead = mast(b, [0, top, front + 3], Math.max(height * 0.25, 3), 2);
  const room = L / 2 - back;
  const funnelAt = room > 8 ? back + 4 : back - 4;
  funnel(
    b,
    [0, top - DECK, funnelAt],
    Math.max(height * 0.35, 4),
    clamp(L * 0.025, 1.5, 5),
    clamp(B * 0.12, 1, 4),
    0x3a3d42
  );

  // Forward of the house: cargo, from just abaft the bow.
  const [z0, z1] = [-L / 2 + L * 0.1, front - 2];

  if (containers) {
    const rows = Math.floor((B * 0.92) / 2.5);
    const bays = Math.floor((z1 - z0) / 12.8);

    for (let bay = 0; bay < bays; bay++) {
      for (let row = 0; row < rows; row++) {
        const seed = s.mmsi + bay * 101 + row * 7;
        const tiers = Math.floor(random(seed) * 6);

        if (tiers === 0) continue;
        const x = (row - (rows - 1) / 2) * 2.5;
        const z = z0 + bay * 12.8;
        b.use(BOXES[Math.floor(random(seed + 1) * BOXES.length)]);
        b.box([x - 1.2, fb, z], [x + 1.2, fb + tiers * 2.6, z + 12.2]);
      }
    }
  } else if (s.kind === "tanker") {
    b.use(STEEL);
    b.cylinder([0, fb + 1.2, z0], [0, fb + 1.2, z1], clamp(B * 0.02, 0.2, 0.6));

    for (const x of [-B * 0.15, B * 0.15]) {
      b.cylinder(
        [x, fb + 0.6, z0],
        [x, fb + 0.6, z1],
        clamp(B * 0.012, 0.15, 0.4)
      );
    }

    b.use(OFF_WHITE).box([-0.6, fb + 2, z0], [0.6, fb + 2.15, z1]);
    const middle = (z0 + z1) / 2;
    b.use(STEEL).cylinder(
      [B * 0.3, fb, middle],
      [B * 0.3, fb + 5, middle],
      0.4
    );
    b.cylinder(
      [B * 0.3, fb + 5, middle],
      [-B * 0.05, fb + 6.5, middle + 2],
      0.25
    );
  } else {
    // Holds under hatch covers, with a crane between each pair.
    const holds = clamp(Math.round((z1 - z0) / 25), 1, 7);
    const pitch = (z1 - z0) / holds;

    for (let i = 0; i < holds; i++) {
      const z = z0 + i * pitch;
      b.use(0x4e4e4e).box(
        [-B * 0.38, fb, z + 3],
        [B * 0.38, fb + 1.6, z + pitch - 1]
      );

      if (i === 0) continue;
      const foot: Vec = [B * 0.3 * (i % 2 ? 1 : -1), fb, z + 1];
      b.use(OFF_WHITE).cylinder(foot, [foot[0], fb + 9, foot[2]], 0.9);
      b.cylinder(
        [foot[0], fb + 8, foot[2]],
        [-foot[0] * 0.4, fb + 15, foot[2] + pitch * 0.5],
        0.35
      );
    }
  }

  // A foremast near the bow.
  mast(b, [0, fb + 1, -L / 2 + L * 0.05], clamp(L * 0.06, 4, 12), 0);

  return {
    masthead,
    port: [-B / 2, top - 1, front + 1],
    starboard: [B / 2, top - 1, front + 1],
    stern: [0, fb + 1, L / 2],
    anchor: masthead,
  };
}

/** A sailing yacht: low cabin top, mast and boom, stays. */
function yacht(b: ModelBuilder, s: ShipSpec): Lights {
  const { length: L, beam: B, freeboard: fb } = s;
  b.sides = 6;

  hull(b, {
    length: L,
    beam: B,
    freeboard: fb,
    draft: fb * 1.2,
    entry: 0.5,
    run: 0.2,
    transom: 0.75,
    rake: L * 0.08,
    sheer: fb * 0.25,
    sides: WHITE,
    deck: 0xcfcfcf,
  });

  house(b, {
    z0: -L / 2 + L * 0.3,
    z1: -L / 2 + L * 0.66,
    y0: fb,
    y1: fb + Math.max(0.5, L * 0.05),
    half: (B / 2) * 0.55,
    rake: 0.5,
    color: OFF_WHITE,
    windows: [{ from: 0.15, to: 0.35, pitch: 0.9, width: 0.6, lit: true }],
  });

  const foot: Vec = [0, fb, -L / 2 + L * 0.33];
  const height = L * 1.3;
  const top: Vec = [0, fb + height, foot[2]];
  const r = Math.max(0.06, L * 0.007);
  b.use(OFF_WHITE).cylinder(foot, top, r);
  b.cylinder([0, fb + 1.2, foot[2]], [0, fb + 1.3, -L / 2 + L * 0.85], r);
  // The mainsail, furled on its boom.
  b.use(0x7a7a7a).cylinder(
    [0, fb + 1.45, foot[2] + 0.3],
    [0, fb + 1.45, -L / 2 + L * 0.8],
    r * 2
  );

  b.use(STEEL);
  b.cylinder(top, [0, fb + L * 0.03, -L / 2 + 0.2], 0.02);
  b.cylinder(top, [0, fb, L / 2 - 0.2], 0.02);

  return {
    masthead: top,
    port: [-B * 0.3, fb + 0.3, -L / 2 + L * 0.1],
    starboard: [B * 0.3, fb + 0.3, -L / 2 + L * 0.1],
    stern: [0, fb + 0.3, L / 2],
    anchor: top,
  };
}

/** A launch: cabin with a raked windscreen, a flybridge on bigger ones. */
function launch(b: ModelBuilder, s: ShipSpec): Lights {
  const { length: L, beam: B, freeboard: fb } = s;
  b.sides = 6;

  hull(b, {
    length: L,
    beam: B,
    freeboard: fb,
    draft: fb * 0.7,
    entry: 0.45,
    run: 0.1,
    transom: 0.9,
    rake: L * 0.06,
    sheer: fb * 0.35,
    sides: WHITE,
    deck: 0xd8d8d8,
  });

  const front = -L / 2 + L * 0.26;
  const height = Math.max(1.2, L * 0.12);
  house(b, {
    z0: front,
    z1: -L / 2 + L * 0.7,
    y0: fb,
    y1: fb + height,
    half: (B / 2) * 0.82,
    rake: height * 0.8,
    color: WHITE,
    windows: [
      {
        from: height * 0.35,
        to: height * 0.85,
        pitch: 1.1,
        width: 0.95,
        lit: true,
        front: true,
      },
    ],
  });

  let top = fb + height;

  if (L >= 12) {
    // A flybridge: a low screen round an open helm.
    house(b, {
      z0: front + height + 0.5,
      z1: -L / 2 + L * 0.66,
      y0: top,
      y1: top + 0.9,
      half: (B / 2) * 0.7,
      rake: 0.5,
      color: WHITE,
    });
    top += 0.9;
  }

  const masthead = mast(b, [0, top, -L / 2 + L * 0.5], 1.2, 0.3);

  return {
    masthead,
    port: [-(B / 2) * 0.8, fb + 0.3, front],
    starboard: [(B / 2) * 0.8, fb + 0.3, front],
    stern: [0, fb + 0.3, L / 2],
    anchor: masthead,
  };
}

/** A fishing boat or workboat: wheelhouse forward, a gantry over the stern. */
function workboat(b: ModelBuilder, s: ShipSpec): Lights {
  const { length: L, beam: B, freeboard: fb } = s;
  b.sides = 6;
  const fishing = s.kind === "fishing";

  hull(b, {
    length: L,
    beam: B,
    freeboard: fb,
    draft: fb * 1.1,
    entry: 0.4,
    run: 0.15,
    transom: 0.85,
    rake: L * 0.04,
    sheer: fb * 0.5,
    sides: fishing ? 0x4a4a4a : 0x3f3f3f,
    deck: STEEL,
  });

  const front = -L / 2 + L * (fishing ? 0.15 : 0.28);
  const height = Math.max(2.2, L * 0.15);
  house(b, {
    z0: front,
    z1: front + L * 0.27,
    y0: fb,
    y1: fb + height,
    half: (B / 2) * 0.72,
    rake: 0.3,
    color: fishing ? OFF_WHITE : WHITE,
    windows: [
      {
        from: height - 1.2,
        to: height - 0.3,
        pitch: 1,
        width: 0.85,
        front: true,
        lit: true,
      },
    ],
  });

  const masthead = mast(b, [0, fb + height, front + 1.5], 3, 0.8);

  // An A-frame gantry over the stern.
  b.use(STEEL);
  const z = L / 2 - L * 0.06;
  const up = fb + Math.max(3, L * 0.18);

  for (const sign of [-1, 1]) {
    b.cylinder(
      [sign * (B / 2) * 0.75, fb, z],
      [sign * (B / 2) * 0.6, up, z],
      0.15
    );
  }

  b.cylinder([-(B / 2) * 0.6, up, z], [(B / 2) * 0.6, up, z], 0.15);

  return {
    masthead,
    port: [-(B / 2) * 0.72, fb + height - 0.8, front + 0.5],
    starboard: [(B / 2) * 0.72, fb + height - 0.8, front + 0.5],
    stern: [0, fb + 0.6, L / 2],
    anchor: masthead,
  };
}

type Design = (b: ModelBuilder, s: ShipSpec) => Lights;

/** The harbour's regulars, by name as their AIS gives it, letters only. */
const NAMED = new Map(
  Object.entries({
    KAITAKI: kaitaki,
    KAIARAHI: visentini(true),
    CONNEMARA: visentini(false),
    LIVIA: visentini(false),
  } satisfies Record<string, Design>)
);

function designFor({ name, kind, length }: ShipSpec): Design {
  const named = NAMED.get((name ?? "").toUpperCase().replace(/[^A-Z]/g, ""));

  if (named) return named;

  switch (kind) {
    case "passenger":
      // East by West's harbour ferries are catamarans.
      return length >= 80 ? cruise : length < 45 ? catamaran : launch;
    case "cargo":
    case "tanker":
      return length >= 50 ? merchant : workboat;
    case "tug":
      return tug;
    case "pilot":
      return pilot;
    case "sailing":
      return yacht;
    case "pleasure":
      return launch;
    default:
      return workboat;
  }
}

/** A ship's detailed model, and where its lights are on it. */
export function createShipModel(spec: ShipSpec) {
  const b = new ModelBuilder();
  const lights = designFor(spec)(b, spec);

  return { geometry: b.build(), lights };
}
