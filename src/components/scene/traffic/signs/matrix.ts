import {
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Node,
  RedFormat,
  UnsignedByteType,
} from "three/webgpu";
import {
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  mix,
  smoothstep,
  texture,
  vec2,
  vec3,
} from "three/tsl";

// Signs made of lamps, as the scene lights them: the motorway's message
// signs, and the signs on the buses. Which lamps are lit is a map, a lamp
// to a texel; each is drawn as a round dot of amber in its square.

const AMBER = new Color(1, 0.5, 0.03);

/**
 * How bright a lit lamp is, by day and by night (they're dimmed after
 * dark).
 */
const LAMP_DAY = 2;
const LAMP_NIGHT = 1.4;

/** A lamp's round, within its square of the grid: lit to here, dark by here. */
const LAMP = [0.4, 0.56];

/** Lamps this many to a pixel, and they're drawn as their blur: from, to. */
const BLURRED = [0.35, 0.9];

/** A lamp's share of its square, for the blur to be as bright. */
const LAMP_SHARE = 0.8;

/**
 * A map of `lamps`, a byte each (255 lit, 0 dark), `width` to a row from
 * the top. Set `needsUpdate` once they change.
 */
export function createLampMap(lamps: Uint8Array, width: number) {
  const map = new DataTexture(
    lamps,
    width,
    lamps.length / width,
    RedFormat,
    UnsignedByteType
  );

  map.magFilter = LinearFilter;
  map.minFilter = LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;

  return map;
}

/**
 * The light off the lamps of `map` at `at`, in lamps across and down from
 * the map's corner: amber dots, or further off than a lamp to a pixel, the
 * map's own blur. `night` is how far through lighting-up it is, 0..1.
 */
export function lampLight(
  map: DataTexture,
  at: Node<"vec2">,
  night: Node<"float">
) {
  const size = vec2(map.image.width, map.image.height);

  const lamp = texture(map, floor(at).add(0.5).div(size))
    .level(float(0))
    .r.mul(smoothstep(LAMP[1], LAMP[0], length(fract(at).sub(0.5))));

  const blur = texture(map, at.div(size)).r.mul(LAMP_SHARE);

  const glow = mix(
    lamp,
    blur,
    smoothstep(BLURRED[0], BLURRED[1], max(fwidth(at.x), fwidth(at.y)))
  );

  return vec3(AMBER.r, AMBER.g, AMBER.b)
    .mul(glow)
    .mul(mix(float(LAMP_DAY), float(LAMP_NIGHT), night));
}
