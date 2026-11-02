import {
  DataTexture,
  NearestFilter,
  RGBAFormat,
  UnsignedByteType,
} from "three/webgpu";
import { max, texture, vec2 } from "three/tsl";
import type { Node } from "three/webgpu";
import { HEROES } from "./heroes";

// The waterfront's landmarks lit up at night: uplights washing their walls,
// more windows on than the rest of the city, a roof picked out. The models
// carry no names, so it goes by where they stand: OSM footprints painted
// into a map over the waterfront, each texel holding its building's lighting.

interface Lighting {
  /** Uplight on the walls, times the wall's albedo at their foot. */
  flood: number;
  /** Metres up the wall the uplights carry, falling off as exp(-h/reach). */
  reach: number;
  /** Share of windows lit, whatever the hour. */
  windows: number;
  /** Light on the roof, times its albedo. */
  crown: number;
}

// Looks from photos at dusk; how strong is eyeballed.
const LIGHTING: Record<keyof typeof HEROES, Lighting> = {
  // Floodlit stone, a lit roof crown, the glazed entrance hall aglow.
  tePapa: { flood: 1, reach: 6, windows: 0.55, crown: 0.4 },
  // Glass walls lit from inside.
  takina: { flood: 0.6, reach: 5, windows: 0.8, crown: 0 },
  michaelFowler: { flood: 1.2, reach: 8, windows: 0.4, crown: 0 },
  // Queens Wharf: heritage fronts washed, restaurants and offices lit.
  museum: { flood: 2, reach: 10, windows: 0.4, crown: 0 },
  harbourBoard: { flood: 1.5, reach: 8, windows: 0.5, crown: 0 },
  shed6: { flood: 1.2, reach: 6, windows: 0.75, crown: 0 },
  shed5: { flood: 1.2, reach: 5, windows: 0.75, crown: 0 },
  queensWharf: { flood: 0.6, reach: 5, windows: 0.75, crown: 0 },
  meridian: { flood: 0.3, reach: 5, windows: 0.7, crown: 0 },
  deloitte: { flood: 0.3, reach: 6, windows: 0.85, crown: 0 },
};

/** Largest of each, for packing into bytes. */
const FLOOD_MAX = 4;
const REACH_MAX = 32;
const CROWN_MAX = 2;

/** Map resolution, metres per texel. */
const TEXEL = 2;

/**
 * Footprints are grown by this much, metres, so walls (on the edge, and
 * not quite where OSM has them) fall inside.
 */
const GROW = 4;

/** Distance from (x, y) to the segment a–b. */
function segmentDistance(
  x: number,
  y: number,
  [ax, ay]: number[],
  [bx, by]: number[]
) {
  const dx = bx - ax;
  const dy = by - ay;

  const t = Math.min(
    Math.max(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0),
    1
  );

  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/** Within `grow` of the polygon `ring`, or inside it. */
function covers(ring: number[][], x: number, y: number, grow: number) {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    if (segmentDistance(x, y, ring[i], ring[j]) < grow) return true;

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

const byte = (value: number, most: number) =>
  Math.round(Math.min(Math.max(value / most, 0), 1) * 255);

/**
 * The waterfront's lighting map, for a world frame whose origin is the NZTM
 * `origin` (x east, z south). Returns a lookup of the lighting at a world
 * position, none away from the landmarks, and the map, to dispose of.
 */
export function createFloodlights([e0, n0]: readonly number[]) {
  const rings = Object.entries(HEROES).map(([key, ring]) => ({
    // SAFETY: key comes from HEROES's own entries, which LIGHTING covers.
    lighting: LIGHTING[key as keyof typeof HEROES],
    ring: ring.map(([e, n]) => [e - e0, n0 - n]),
  }));

  const all = rings.flatMap(({ ring }) => ring);
  // A texel of nothing around the edge, which the lookup clamps to.
  const pad = GROW + TEXEL * 2;
  const x0 = Math.min(...all.map(([x]) => x)) - pad;
  const z0 = Math.min(...all.map(([, z]) => z)) - pad;

  const width = Math.ceil(
    (Math.max(...all.map(([x]) => x)) + pad - x0) / TEXEL
  );

  const height = Math.ceil(
    (Math.max(...all.map(([, z]) => z)) + pad - z0) / TEXEL
  );

  const data = new Uint8Array(width * height * 4);

  for (const { lighting, ring } of rings) {
    const xs = ring.map(([x]) => x);
    const zs = ring.map(([, z]) => z);
    const i0 = Math.floor((Math.min(...xs) - GROW - x0) / TEXEL);
    const i1 = Math.ceil((Math.max(...xs) + GROW - x0) / TEXEL);
    const j0 = Math.floor((Math.min(...zs) - GROW - z0) / TEXEL);
    const j1 = Math.ceil((Math.max(...zs) + GROW - z0) / TEXEL);

    const texel = [
      byte(lighting.flood, FLOOD_MAX),
      byte(lighting.reach, REACH_MAX),
      byte(lighting.windows, 1),
      byte(lighting.crown, CROWN_MAX),
    ];

    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const x = x0 + (i + 0.5) * TEXEL;
        const z = z0 + (j + 0.5) * TEXEL;

        if (covers(ring, x, z, GROW)) data.set(texel, (j * width + i) * 4);
      }
    }
  }

  const map = new DataTexture(
    data,
    width,
    height,
    RGBAFormat,
    UnsignedByteType
  );

  map.magFilter = NearestFilter;
  map.minFilter = NearestFilter;
  map.generateMipmaps = false;
  map.needsUpdate = true;

  const lookup = (position: Node<"vec3">) => {
    const lit = texture(
      map,
      vec2(
        position.x.sub(x0).div(width * TEXEL),
        position.z.sub(z0).div(height * TEXEL)
      )
    );

    return {
      flood: lit.r.mul(FLOOD_MAX),
      reach: max(lit.g.mul(REACH_MAX), 1),
      windows: lit.b,
      crown: lit.a.mul(CROWN_MAX),
    };
  };

  return { lookup, map };
}
