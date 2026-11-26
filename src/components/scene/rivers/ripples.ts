import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
} from "three/webgpu";
import {
  abs,
  attribute,
  exp,
  float,
  fract,
  inverseSqrt,
  max,
  mix,
  sign,
  sin,
  smoothstep,
  texture,
  time,
  vec2,
  vec4,
} from "three/tsl";

// A river's surface, moving: a pattern of ripples carried downstream by the
// water's speed (./flow.ts), station by station, quicker mid-channel than
// by the banks. Carried for ever, a pattern in water that shears would smear
// out, so it's carried a few seconds only and begun again, twice over and
// half a turn apart, each faded out as it's reset: a flow map's two phases.

/** The pattern's size, texels: it repeats. */
const SIZE = 256;

/** Each phase carries the pattern for this long before it's begun again, s. */
const CYCLE = 12;

/**
 * The pattern's carried this many times faster than the water runs. A
 * river's a metre a second or so, which from a hundred metres up is a pixel
 * or two a second: true, and it looks stood still. Its speeds stay in
 * proportion: a riffle's still twice a pool's. (A narrow stream's carried
 * quicker again: see `hurry` below.)
 */
const HASTE = 2;

/**
 * The pattern's laid along and across the river at two sizes, m to a
 * repeat: long streaks a few metres wide, and ripples in them. Longer along
 * than across, as moving water draws everything out.
 */
const COARSE = [90, 14];
const FINE = [46, 4.5];

/** Mid-channel runs this much over the river's mean, the bank's under. */
const MIDSTREAM = 1.2;
const BANK = 0.4;

/**
 * The surface's tilt (a slope, as rise over run): this on any water, as the
 * wind and its own eddies leave it, this more for each m/s it runs at, and
 * this more where it's all broken.
 */
const CALM = 0.08;
const RUFFLE = 0.05;
const BROKEN = 0.22;

/**
 * The ripples lie in lanes, drawn out down the current, with slicks of
 * glassy water between: a slick has this share of the ripples, a lane this
 * many times them. What's seen moving on smooth water, however slow.
 */
const SLICK = 0.5;
const LANE = 1.5;

/**
 * The lanes are this long, m to a repeat of the pattern, and a few to the
 * channel's width whatever that is: a creek's are a metre or two across, an
 * estuary's tens, and they draw together where it narrows, as its
 * streamlines do. And a lane's this much lighter than a slick, of -1..1.
 */
const LANES = 260;
const ACROSS = 0.45;
const LIGHTER = 0.4;

/**
 * That's a channel up to this wide, m. A wider one has more lanes, each as
 * wide as this one's: a few to an estuary's width are as broad as they're
 * long, and it's blotched with them, like a hide.
 */
const WIDE = 40;

/**
 * Lane shades into slick over this much of the lanes' field either way, of
 * -0.5..0.5: most of its spread, so the water's every tone between the two
 * and not patches of one or the other.
 */
const EDGE = 0.35;

/**
 * Nor are the lanes as plain everywhere: stretches of the water show them,
 * and stretches between are near enough all one tone, as a breeze gets at
 * some of a river and not the rest. The stretches are this long and (on a
 * channel WIDE across) this much of the pattern from bank to bank, and the
 * lanes in the plainest are this share of what they are in the most marked.
 */
const STRETCHES = [900, 0.12];
const PLAIN = 0.45;

/**
 * At its most broken, this much of the surface is white; and between the
 * patches it comes down in, this share of that.
 */
const WHITEST = 0.75;
const PATCHY = 0.35;

/**
 * Foam lies on running water in lines, drawn out along the current: each
 * drawn on its own into the pattern (so no two are alike, and its mips hold
 * how much of the surface they cover), this many of them to a repeat, which
 * is this far along and across the river, m. At most this much of a line is
 * white. How much of the river has them is its `foam`: raised where it's
 * stirred, thinning out downstream (./flow.ts).
 */
const FILAMENTS = 16;
const LINES = [230, 26];
const FOAM = 0.7;

/**
 * The lines sway this far from side to side on their way down, m, and
 * gather into a band that wanders across the channel, as a river's main
 * current does: neither's in the pattern, so neither repeats with it.
 */
const SWAY = 2.5;

/** The pattern, as texels: a hash of a lattice point, 0..1. */
function hash(x: number, y: number, seed: number) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;

  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);

  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/**
 * Smooth noise over the unit square that repeats: `octaves` of it, the
 * first with `cells` lattice cells across, each after twice as fine and
 * half as strong.
 */
function repeating(cells: number, octaves: number, seed: number) {
  const out = new Float32Array(SIZE * SIZE);
  let strength = 1;

  for (let octave = 0; octave < octaves; octave++) {
    const across = cells * 2 ** octave;

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const [u, v] = [(x / SIZE) * across, (y / SIZE) * across];
        const [i, j] = [Math.floor(u), Math.floor(v)];
        const [s, t] = [u - i, v - j].map((f) => f * f * (3 - 2 * f));
        const [i1, j1] = [(i + 1) % across, (j + 1) % across];
        const key = seed + octave;

        out[y * SIZE + x] +=
          strength *
          ((1 - t) * ((1 - s) * hash(i, j, key) + s * hash(i1, j, key)) +
            t * ((1 - s) * hash(i, j1, key) + s * hash(i1, j1, key)));
      }
    }

    strength /= 2;
  }

  return out;
}

/** The least and the most of a field. */
function span(field: Float32Array) {
  let [least, most] = [Infinity, -Infinity];

  for (const value of field) {
    least = Math.min(least, value);
    most = Math.max(most, value);
  }

  return [least, most];
}

/**
 * Lines of foam, 0..1: each begun somewhere of its own, its own length and
 * width, wandering a little, tapered to nothing at both ends and thin in
 * places on the way.
 */
function filaments() {
  const out = new Float32Array(SIZE * SIZE);
  const wrap = (i: number) => ((i % SIZE) + SIZE) % SIZE;
  const turn = 2 * Math.PI;

  for (let line = 0; line < FILAMENTS; line++) {
    const random = (which: number) => hash(line, which, 131);
    const from = random(0) * SIZE;
    const length = (0.12 + 0.5 * random(1) ** 2) * SIZE;
    // Spread over the pattern's width, each in a lane of its own.
    const lane = ((line + random(2)) / FILAMENTS) * SIZE;
    const widest = 1.4 + 2 * random(3);
    const strength = 0.55 + 0.45 * random(4);

    for (let step = 0; step < length; step++) {
      const along = step / length;
      const x = wrap(Math.floor(from + step));

      const middle =
        lane +
        12 * Math.sin(turn * (along * (0.6 + random(5)) + random(6))) +
        4 * Math.sin(turn * (along * (2 + 2 * random(7)) + random(8)));

      const taper = Math.sin(Math.PI * along) ** 0.6;

      const thinned =
        0.7 + 0.3 * Math.sin(turn * (along * (3 + 4 * random(9)) + random(10)));

      const half = widest * taper * thinned + 0.5;

      for (let y = Math.floor(middle - half); y <= middle + half + 1; y++) {
        const off = (y - middle) / half;
        const at = wrap(y) * SIZE + x;

        out[at] = Math.max(
          out[at],
          strength * taper * thinned * Math.max(1 - off * off, 0)
        );
      }
    }
  }

  return out;
}

/**
 * The pattern: in red and green a rippled surface's slopes either way (0.5
 * is level), in blue streaks, each over its whole range; and in alpha
 * lines of foam.
 */
export function paintRipples() {
  // Three octaves: a fourth's ripples are under a pixel from any height
  // the river's seen from, and their slopes would be most of the range.
  const heights = repeating(8, 3, 11);
  const streaks = repeating(6, 3, 47);
  const foam = filaments();
  const slopes = [new Float32Array(SIZE * SIZE), new Float32Array(SIZE * SIZE)];
  const wrap = (i: number) => (i + SIZE) % SIZE;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      slopes[0][y * SIZE + x] =
        heights[y * SIZE + wrap(x + 1)] - heights[y * SIZE + wrap(x - 1)];
      slopes[1][y * SIZE + x] =
        heights[wrap(y + 1) * SIZE + x] - heights[wrap(y - 1) * SIZE + x];
    }
  }

  const steepest = Math.max(...slopes.flatMap(span).map(Math.abs));
  const [least, most] = span(streaks);
  const texels = new Uint8Array(SIZE * SIZE * 4);

  for (let i = 0; i < SIZE * SIZE; i++) {
    texels[i * 4] = Math.round(255 * (0.5 + slopes[0][i] / steepest / 2));
    texels[i * 4 + 1] = Math.round(255 * (0.5 + slopes[1][i] / steepest / 2));
    texels[i * 4 + 2] = Math.round(
      (255 * (streaks[i] - least)) / (most - least)
    );
    texels[i * 4 + 3] = Math.round(255 * foam[i]);
  }

  return { size: SIZE, texels };
}

let map: DataTexture | null = null;

/** The pattern on the GPU, made once: every river's drawn with the one. */
function ripplesMap() {
  if (map) return map;

  const { size, texels } = paintRipples();

  map = new DataTexture(texels, size, size);
  map.wrapS = map.wrapT = RepeatWrapping;
  map.magFilter = LinearFilter;
  map.minFilter = LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  // Rivers are seen along their length, low down, as often as not.
  map.anisotropy = 8;
  map.needsUpdate = true;

  return map;
}

/**
 * A river's surface where it's drawn, by its geometry's `flow` (how far
 * down the river, m; how far off its middle, m; its speed there, m/s; how
 * broken, 0..1) and `reach` (its side, -1 at the left bank to 1 at the
 * right; how much foam it carries, 0..1; and the pattern's scale there): `tilt`, its slope along x and z; `white`,
 * how much of it is broken water or foam; and `stir`, -1..1, the lighter
 * and darker water its ripples and currents draw out in it.
 * Far off, the pattern's mips average it away to a level surface, a little
 * paler down a riffle.
 */
export function ripples() {
  const pattern = ripplesMap();
  const flow = attribute<"vec4">("flow", "vec4");
  const reach = attribute<"vec3">("reach", "vec3");
  const side = reach.x;
  // The pattern's metres to the river's: under 1 on a narrow one.
  const scale = reach.z;
  const rough = flow.w;

  const speed = flow.z.mul(
    float(1)
      .sub(side.mul(side))
      .mul(MIDSTREAM - BANK)
      .add(BANK)
  );

  // A stream's seen from as far off as a river is, and at a river's haste
  // its water crawls: carried quicker the narrower it is, by the root of
  // how much smaller its pattern's drawn (twice as quick at a quarter).
  const hurry = inverseSqrt(scale);

  const turn = time.div(CYCLE);
  const first = fract(turn);
  const second = fract(turn.add(0.5));

  // The first counts for nothing as it's begun again (0 and 1), and for
  // everything half way; the second's the other way about.
  const share = abs(first.mul(2).sub(1));

  // Its foam's gathered into a band a third or so of the channel wide,
  // which crosses from side to side on the way down; thin outside it.
  const band = side
    .sub(
      sin(flow.x.div(113))
        .mul(0.5)
        .add(sin(flow.x.div(41).add(2)).mul(0.25))
    )
    .mul(2.2);

  const foam = reach.y
    .mul(exp(band.mul(band).negate()).mul(0.9).add(0.3))
    .min(1);

  const sway = sin(flow.x.div(47).add(sin(flow.x.div(19)).mul(1.3))).mul(SWAY);

  // How far across, for the lanes: the side, bank to bank, on a channel up
  // to WIDE across, and on a wider one as far as that again each WIDE.
  const across = sign(side).mul(max(abs(side), abs(flow.y).div(WIDE / 2)));

  /**
   * The pattern `phase` of the way through its carry, moved on `shift`:
   * its slopes either way, its streaks about 0, and what's white in it.
   */
  const carried = (phase, shift: number) => {
    const at = vec2(
      flow.x.sub(
        speed
          .div(scale)
          .mul(hurry)
          .mul(HASTE * CYCLE)
          .mul(float(phase).sub(0.5))
      ),
      flow.y
    );

    const coarse = texture(pattern, at.div(vec2(...COARSE)).add(shift));
    const fine = texture(pattern, at.div(vec2(...FINE)).add(shift * 1.7));
    const streak = coarse.z.mul(0.4).add(fine.z.mul(0.6));

    // Broken water: long soft streaks of it down a riffle, most of the
    // surface down a rapid, none in a pool. By the coarse streaks more than
    // the fine, or it's all spots of a size.
    const broken = smoothstep(
      0,
      0.45,
      coarse.z
        .mul(0.65)
        .add(fine.z.mul(0.35))
        .sub(float(0.8).sub(rough.mul(0.75)))
    )
      .mul(smoothstep(0, 0.25, rough))
      .mul(WHITEST);

    // Lines of foam, in the stretches of the river that have any: all of
    // them just under a riffle, fewer and fewer on down.
    const drawn = texture(
      pattern,
      vec2(at.x, at.y.add(sway))
        .div(vec2(...LINES))
        .add(shift * 2.3)
    );

    const lanes = texture(
      pattern,
      vec2(at.x.div(LANES), across.mul(ACROSS)).add(shift * 3.1)
    ).z;

    const lines = drawn.w
      .mul(smoothstep(0, 0.2, drawn.z.add(foam.mul(1.1)).sub(1)))
      .mul(FOAM);

    return {
      marks: vec4(
        coarse.x.add(fine.x).sub(1),
        coarse.y.add(fine.y).sub(1),
        streak.sub(0.5),
        lanes.sub(0.5)
      ),
      // Broken water comes down in patches, by the lanes: or a stream
      // that's white from bank to bank is one white ribbon, stood still.
      white: broken
        .mul(mix(PATCHY, 1, smoothstep(0.3, 0.7, lanes)))
        .add(lines)
        .min(1),
    };
  };

  const one = carried(first, 0);
  const other = carried(second, 0.37);

  // Two patterns half and half would be flatter than either: kept as strong
  // as one, so the surface doesn't pulse as they trade places.
  const blended = mix(one.marks, other.marks, share).mul(
    inverseSqrt(
      share.mul(share).add(float(1).sub(share).mul(float(1).sub(share)))
    )
  );

  // Rippled lanes and the slicks between, soft-edged.
  const lane = smoothstep(-EDGE, EDGE, blended.w);

  // Where they show: not carried with the water, as its ripples are.
  const marked = mix(
    PLAIN,
    1,
    smoothstep(
      0.35,
      0.65,
      texture(
        pattern,
        vec2(flow.x.div(STRETCHES[0]), across.mul(STRETCHES[1])).add(0.61)
      ).z
    )
  );

  // Out past the coast it's the sea's surface, which has waves of its own.
  const river = attribute<"float">("fade", "float");

  return {
    tilt: blended.xy
      .mul(
        speed
          .mul(RUFFLE)
          .add(CALM)
          .mul(mix(SLICK, LANE, lane))
          .add(rough.mul(BROKEN))
      )
      .mul(river),
    // What's white is found in each pattern, then the two faded across, so
    // a line of foam comes and goes whole.
    white: mix(one.white, other.white, share),
    // A rippled lane's lighter than a slick, from any height, and marked
    // by its ripples, which a slick isn't: the more the quicker the water.
    stir: lane
      .mul(2)
      .sub(1)
      .mul(LIGHTER)
      .mul(marked)
      .add(
        blended.z
          .mul(2)
          .mul(lane)
          .mul(mix(0.5, 1, smoothstep(0.1, 0.9, speed)))
      )
      .clamp(-1, 1)
      .mul(river),
  };
}
