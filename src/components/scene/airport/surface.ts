import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  Texture,
  TextureLoader,
} from "three/webgpu";
import {
  abs,
  clamp,
  float,
  floor,
  fwidth,
  max,
  min,
  mix,
  sin,
  smoothstep,
  texture,
  vec2,
} from "three/tsl";
import type { TerrainManifest } from "../terrain/manifest";
import { AIRFIELD_TEXTURES, RUNWAY } from "./airfield";

// Wellington Airport's runway, taxiways and aprons, painted into the terrain.
// The runway's markings are drawn from its geometry, so they stay sharp up
// close; taxiways and aprons come from textures baked by
// scripts/airport/build_airfield.mjs.

export const AIRFIELD_URL = "/airport";

/** Albedos, in the scene's greys. */
const ASPHALT = 0.075;
const CONCRETE = 0.2;
const RUBBER = 0.035;
const PAINT = 0.5;
/** Taxiway yellow, as a grey. */
const TAXI_PAINT = 0.3;
/** Mowing stripes across the grass, metres per pair, and their contrast. */
const MOWING = 18;
const MOWING_CONTRAST = 0.07;

// Runway markings, ICAO Annex 14, in metres from the threshold (t) and from
// the centreline (s), for a 45 m precision runway landing under 2400 m.
const THRESHOLD_STRIPES = { from: 6, length: 30, count: 6 };
/** Stripes stop this far short of the runway's edge. */
const THRESHOLD_EDGE_CLEAR = 3;
const THRESHOLD_BAR = 1.8;
const DESIGNATOR = { from: 48, height: 9, width: 7.5 };
const AIMING_POINT = { from: 300, length: 45, inner: 9, width: 6 };
/** Touchdown zone: [from, stripes per side]. */
const TOUCHDOWN: [number, number][] = [
  [150, 3],
  [450, 2],
  [600, 2],
];
const TOUCHDOWN_STRIPE = { length: 22.5, width: 1.8, gap: 1.5 };
const CENTRELINE = { from: 69, dash: 30, gap: 20, width: 0.45 };
const SIDE_STRIPE = 0.9;
/** Arrows down the displaced part of the runway, pointing to the threshold. */
const ARROW = { tip: 12, head: 10, headWidth: 5, shaft: 20, spacing: 50 };
/** Chevrons on the stopways. */
const CHEVRON = { spacing: 15, width: 1 };
const TAXI_LINE = 0.15;

export interface AirfieldMaps {
  /** Taxiway markings (see AIRFIELD_TEXTURES). */
  lines: Texture;
  /** Paving, grass and concrete. */
  ground: Texture;
  /** Runway numbers: "34" in the left half, "16" in the right. */
  designators: Texture;
  /** World x/z of the textures' north-west corner, and their extent. */
  bounds: [number, number, number, number];
  /** World x/z of the runway's south end. */
  runwayStart: [number, number];
}

function loadTexture(name: string, mipmaps = true) {
  const map = new TextureLoader().load(`${AIRFIELD_URL}/${name}`);
  map.colorSpace = NoColorSpace;
  map.flipY = false;
  map.generateMipmaps = mipmaps;
  map.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter;
  map.magFilter = LinearFilter;
  map.anisotropy = 8;
  return map;
}

/** The two runway numbers, white on black, each filling half the canvas. */
function createDesignators() {
  const cell = [320, 384];
  const canvas = document.createElement("canvas");
  canvas.width = cell[0] * 2;
  canvas.height = cell[1];
  const context = canvas.getContext("2d");
  if (!context) {
    const empty = new DataTexture(new Uint8Array(4), 1, 1);
    empty.needsUpdate = true;
    return empty;
  }
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#fff";
  context.font = "bold 400px Helvetica, Arial, sans-serif";
  context.textBaseline = "alphabetic";
  ["34", "16"].forEach((text, k) => {
    const m = context.measureText(text);
    const glyphWidth = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    const glyphHeight = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    // Stretched tall and narrow to fill the cell, as painted.
    const pad = 6;
    const sx = (cell[0] - pad * 2) / glyphWidth;
    const sy = (cell[1] - pad * 2) / glyphHeight;
    context.setTransform(
      sx,
      0,
      0,
      sy,
      k * cell[0] + pad + m.actualBoundingBoxLeft * sx,
      pad + m.actualBoundingBoxAscent * sy
    );
    context.fillText(text, 0, 0);
  });
  context.setTransform(1, 0, 0, 1, 0, 0);

  const map = new CanvasTexture(canvas);
  map.colorSpace = NoColorSpace;
  map.flipY = false;
  map.minFilter = LinearMipmapLinearFilter;
  map.magFilter = LinearFilter;
  map.anisotropy = 8;
  return map;
}

export function createAirfieldMaps(manifest: TerrainManifest): AirfieldMaps {
  const [west, south, east, north] = AIRFIELD_TEXTURES.bounds;
  const [originE, originN] = manifest.origin;
  return {
    lines: loadTexture("lines.png"),
    ground: loadTexture("ground.png"),
    designators: createDesignators(),
    bounds: [west - originE, -(north - originN), east - west, north - south],
    runwayStart: [RUNWAY.south[0] - originE, -(RUNWAY.south[1] - originN)],
  };
}

export function disposeAirfieldMaps(maps: AirfieldMaps) {
  maps.lines.dispose();
  maps.ground.dispose();
  maps.designators.dispose();
}

// --- Filtered shapes: coverage of the pixel's footprint, so thin lines fade
// rather than shimmer. `w` is the footprint's width in the same units. ---

/** Share of [x - w/2, x + w/2] inside [lo, hi]. */
function box(x, lo, hi, w) {
  const h = w.mul(0.5);
  return max(min(x.add(h), hi).sub(max(x.sub(h), lo)), 0).div(w);
}

/**
 * `count` stripes over [lo, hi] of each period from x = 0. Integrates the
 * pattern across the footprint, so it greys out evenly in the distance.
 */
function stripes(x, period: number, lo: number, hi: number, count: number, w) {
  const integral = (v) => {
    const c = clamp(v, 0, period * count);
    const k = floor(c.div(period));
    return k.mul(hi - lo).add(clamp(c.sub(k.mul(period)).sub(lo), 0, hi - lo));
  };
  const h = w.mul(0.5);
  return integral(x.add(h)).sub(integral(x.sub(h))).div(w);
}

/** A line along a distance field, at least a pixel wide but no brighter. */
function line(distance, halfWidth: number) {
  const w = max(fwidth(distance), 0.0001);
  const drawn = max(float(halfWidth), w.mul(0.5));
  const cover = clamp(drawn.sub(distance).div(w).add(0.5), 0, 1);
  return cover.mul(float(halfWidth).div(drawn));
}

/**
 * One end's markings. `t` runs from its threshold down the runway, `s` to
 * the right of a pilot landing there; `wt`, `ws` are their footprints.
 */
function endMarkings(
  { t, s, wt, ws },
  displaced: number,
  designators: Texture,
  cell: number
) {
  const side = abs(s);
  const halfWidth = RUNWAY.width / 2;

  const unit = (halfWidth - THRESHOLD_EDGE_CLEAR) / (THRESHOLD_STRIPES.count * 2);
  const threshold = box(
    t,
    THRESHOLD_STRIPES.from,
    THRESHOLD_STRIPES.from + THRESHOLD_STRIPES.length,
    wt
  ).mul(stripes(side, unit * 2, unit, unit * 2, THRESHOLD_STRIPES.count, ws));

  const bar = box(t, -THRESHOLD_BAR, 0, wt).mul(
    box(side, 0, halfWidth - SIDE_STRIPE, ws)
  );

  const aiming = box(
    t,
    AIMING_POINT.from,
    AIMING_POINT.from + AIMING_POINT.length,
    wt
  ).mul(box(side, AIMING_POINT.inner, AIMING_POINT.inner + AIMING_POINT.width, ws));

  const { length, width, gap } = TOUCHDOWN_STRIPE;
  let touchdown: any = float(0);
  for (const [from, count] of TOUCHDOWN) {
    touchdown = touchdown.add(
      box(t, from, from + length, wt).mul(
        stripes(side.sub(AIMING_POINT.inner), width + gap, 0, width, count, ws)
      )
    );
  }

  // The number, upright to a pilot on the approach.
  const top = DESIGNATOR.from + DESIGNATOR.height;
  const u = s.div(DESIGNATOR.width).add(0.5);
  const v = float(top).sub(t).div(DESIGNATOR.height);
  const inCell = box(u, 0, 1, float(0.001)).mul(box(v, 0, 1, float(0.001)));
  const number = texture(designators, vec2(u.add(cell).mul(0.5), v)).r.mul(
    inCell
  );

  // Arrows down the displaced length, each a shaft and a head.
  let arrows: any = float(0);
  for (
    let tip = -ARROW.tip;
    tip - ARROW.head - ARROW.shaft > -displaced;
    tip -= ARROW.spacing
  ) {
    const back = tip - ARROW.head;
    const headHalf = float(tip)
      .sub(t)
      .div(ARROW.head)
      .mul(ARROW.headWidth / 2);
    const head = box(t, back, tip, wt).mul(
      clamp(headHalf.sub(side).div(ws).add(0.5), 0, 1)
    );
    const shaft = box(t, back - ARROW.shaft, back, wt).mul(
      box(s, -CENTRELINE.width, CENTRELINE.width, ws)
    );
    arrows = arrows.add(head).add(shaft);
  }

  return max(
    max(max(threshold, bar), max(aiming, touchdown)),
    max(number, arrows)
  );
}

/**
 * The airfield at world x/z `world`: how much of it is within the aerodrome
 * (grass, unless paved), how much is paved, the paving's albedo with its
 * markings, and a tone for the grass (mowing stripes).
 */
export function shadeAirfield(
  maps: AirfieldMaps,
  { world, detail }: { world: any; detail: Texture }
) {
  const [x0, z0, width, height] = maps.bounds;
  const uv = world.sub(vec2(x0, z0)).div(vec2(width, height));
  const ground = texture(maps.ground, uv);
  const lines = texture(maps.lines, uv);
  const { lineRange, paveRange, holdingDepth } = AIRFIELD_TEXTURES;

  // Runway frame: along from the south end, across positive to the east.
  const [ax, an] = RUNWAY.axis;
  const offset = world.sub(vec2(...maps.runwayStart));
  const a = offset.x.mul(ax).sub(offset.y.mul(an));
  const c = offset.x.mul(an).add(offset.y.mul(ax));
  const wa = max(fwidth(a), 0.0001);
  const wc = max(fwidth(c), 0.0001);
  const halfWidth = RUNWAY.width / 2;
  const [stopSouth, stopNorth] = RUNWAY.stopway;

  const runway = box(a, -stopSouth, RUNWAY.length + stopNorth, wa).mul(
    box(c, -halfWidth, halfWidth, wc)
  );
  const depth = ground.r.sub(0.5).mul(2 * paveRange);
  const taxi = clamp(depth.div(max(fwidth(depth), 0.0001)).add(0.5), 0, 1);
  const paved = max(runway, taxi);
  const field = max(ground.g, runway);

  // Asphalt, concrete aprons, weathered in patches.
  const weathering = texture(detail, world.div(61)).a;
  let albedo: any = mix(ASPHALT, CONCRETE, ground.b.mul(float(1).sub(runway)));
  albedo = albedo.mul(mix(0.8, 1.25, weathering));

  // Tyre rubber where wheels touch down, in streaks along the runway.
  const streaks = texture(detail, vec2(c.div(5), a.div(170))).a;
  const touchdownZone = (t) =>
    smoothstep(60, 250, t).mul(smoothstep(950, 400, t));
  const tracks = smoothstep(9, 2, abs(c)).mul(
    max(
      touchdownZone(a.sub(RUNWAY.threshold34)),
      touchdownZone(float(RUNWAY.threshold16).sub(a))
    )
  );
  albedo = mix(
    albedo,
    float(RUBBER),
    tracks.mul(smoothstep(0.3, 0.7, streaks)).mul(runway).mul(0.85)
  );

  // Runway paint.
  const sideStripes = box(a, 0, RUNWAY.length, wa).mul(
    box(abs(c), halfWidth - SIDE_STRIPE, halfWidth, wc)
  );
  // Whole dashes, centred between the numbers.
  const period = CENTRELINE.dash + CENTRELINE.gap;
  const span =
    RUNWAY.threshold16 - RUNWAY.threshold34 - 2 * CENTRELINE.from;
  const dashes = Math.floor((span + CENTRELINE.gap) / period);
  const firstDash =
    RUNWAY.threshold34 +
    CENTRELINE.from +
    (span - (dashes * period - CENTRELINE.gap)) / 2;
  const centreline = box(c, -CENTRELINE.width / 2, CENTRELINE.width / 2, wc).mul(
    stripes(a.sub(firstDash), period, 0, CENTRELINE.dash, dashes, wa)
  );
  const ends = max(
    endMarkings(
      { t: a.sub(RUNWAY.threshold34), s: c, wt: wa, ws: wc },
      RUNWAY.threshold34,
      maps.designators,
      0
    ),
    endMarkings(
      { t: float(RUNWAY.threshold16).sub(a), s: c.negate(), wt: wa, ws: wc },
      RUNWAY.length - RUNWAY.threshold16,
      maps.designators,
      1
    )
  );
  // Worn where the tyres run.
  const paint = max(max(sideStripes, centreline), ends).mul(
    float(1).sub(tracks.mul(0.4))
  );
  albedo = mix(albedo, float(PAINT), clamp(paint, 0, 1).mul(runway));

  // Chevrons on the stopways, pointing at the runway.
  const beyond = max(a.negate(), a.sub(RUNWAY.length));
  const chevrons = stripes(
    beyond.sub(abs(c).mul(0.5)).add(CHEVRON.spacing * 4),
    CHEVRON.spacing,
    0,
    CHEVRON.width,
    8,
    max(wa, wc)
  ).mul(smoothstep(0, 0.5, beyond));

  // Taxiway centrelines and runway-holding bars, off the runway.
  const toLine = lines.rg.sub(0.5).mul(2 * lineRange).length();
  const taxiMarks = max(
    line(toLine, TAXI_LINE / 2),
    line(lines.b.mul(lineRange), holdingDepth / 2)
  ).mul(taxi);
  albedo = mix(
    albedo,
    float(TAXI_PAINT),
    max(chevrons.mul(runway), taxiMarks.mul(float(1).sub(runway)))
  );

  // Mowing stripes, parallel to the runway, fading before they'd alias.
  const mowing = sin(c.mul((2 * Math.PI) / MOWING))
    .mul(MOWING_CONTRAST)
    .mul(smoothstep(MOWING / 4, MOWING / 12, wc))
    .add(1);

  return { field, paved, albedo, mowing };
}
