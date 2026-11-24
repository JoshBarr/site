import {
  DataTexture,
  NearestFilter,
  RedFormat,
  UnsignedByteType,
} from "three/webgpu";
import { int, texture, uniformArray, vec2 } from "three/tsl";
import type { Node } from "three/webgpu";
import type { VenueKey } from "../../../lib/events";
import { covers } from "../buildings/floodlights";
import { VENUE_SITES } from "./venues";

// The venues lit up while something's on: their walls washed, every window
// bright, the roof aglow. The building models carry no names, so it goes by
// where they stand, as the waterfront's floodlights do: OSM footprints
// painted into a map, each texel holding its venue's slot, and how lit each
// slot is now in a uniform the Events layer keeps.

/** The venues with a footprint to light, in slot order from 1. */
const LIT = Object.entries(VENUE_SITES).flatMap(([key, { ring }]) =>
  // SAFETY: VENUE_SITES's own keys.
  ring ? [{ key: key as VenueKey, ring }] : []
);

const SLOTS = new Map(LIT.map(({ key }, i) => [key, i + 1]));

const unlit = () => Array.from({ length: LIT.length + 1 }, () => 0);

/** Uplight on each venue's walls, times their albedo; slot 0 is none. */
const flood = uniformArray(unlit(), "float");

/** Share of each venue's windows lit. */
const windows = uniformArray(unlit(), "float");

/** Light on each venue's roof, times its albedo. */
const crown = uniformArray(unlit(), "float");

export interface VenueLighting {
  flood: number;
  windows: number;
  crown: number;
}

/** Lights `venue` so; no footprint, no change. */
export function lightVenue(venue: VenueKey, lighting: VenueLighting) {
  const slot = SLOTS.get(venue);

  if (slot === undefined) return;

  flood.array[slot] = lighting.flood;
  windows.array[slot] = lighting.windows;
  crown.array[slot] = lighting.crown;
}

/** Map resolution, metres per texel. */
const TEXEL = 3;

/** Footprints are grown by this much, metres, so their walls fall inside. */
const GROW = 4;

/**
 * The venues' slot map, for a world frame whose origin is the NZTM `origin`
 * (x east, z south). Returns a lookup of the lighting at a world position,
 * none away from the venues, and the map, to dispose of.
 */
export function createVenueGlow([e0, n0]: readonly number[]) {
  const rings = LIT.map(({ ring }) => ring.map(([e, n]) => [e - e0, n0 - n]));
  const all = rings.flat();
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

  const data = new Uint8Array(width * height);

  rings.forEach((ring, i) => {
    const xs = ring.map(([x]) => x);
    const zs = ring.map(([, z]) => z);
    const i0 = Math.floor((Math.min(...xs) - GROW - x0) / TEXEL);
    const i1 = Math.ceil((Math.max(...xs) + GROW - x0) / TEXEL);
    const j0 = Math.floor((Math.min(...zs) - GROW - z0) / TEXEL);
    const j1 = Math.ceil((Math.max(...zs) + GROW - z0) / TEXEL);

    for (let j = j0; j < j1; j++) {
      for (let k = i0; k < i1; k++) {
        const x = x0 + (k + 0.5) * TEXEL;
        const z = z0 + (j + 0.5) * TEXEL;

        if (covers(ring, x, z, GROW)) data[j * width + k] = i + 1;
      }
    }
  });

  const map = new DataTexture(data, width, height, RedFormat, UnsignedByteType);

  map.magFilter = NearestFilter;
  map.minFilter = NearestFilter;
  map.generateMipmaps = false;
  map.needsUpdate = true;

  const lookup = (position: Node<"vec3">) => {
    const slot = int(
      texture(
        map,
        vec2(
          position.x.sub(x0).div(width * TEXEL),
          position.z.sub(z0).div(height * TEXEL)
        )
      )
        .r.mul(255)
        .add(0.5)
    );

    // Floats: three's types lose that for an array's elements.
    const element = (array: typeof flood): any => array.element(slot);

    return {
      flood: element(flood),
      windows: element(windows),
      crown: element(crown),
    };
  };

  return { lookup, map };
}
