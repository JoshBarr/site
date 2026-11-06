import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  type PixelFormat,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
} from "three/webgpu";

// How the land turns and slows the wind, from scripts/wind/build_wind.py:
// over a square grid across the terrain's root, the surface flow for a unit
// wind blowing toward the east and one toward the south. Any wind is the two
// added in proportion, since the model behind them is linear.

const FIELD_URL = "/wind/field.png";

/** Components are stored as 128 + v * FIELD_SCALE, as build_wind.py's SCALE. */
export const FIELD_SCALE = 32;

/**
 * Cells across, rows running south from the root's north edge. Each holds
 * four bytes in `data`: the eastward flow's x and z, then the southward
 * flow's; and one in `land`: how much land's round about, 0..255, blurred
 * over a few hundred metres.
 */
export interface WindField {
  size: number;
  data: Uint8Array;
  land: Uint8Array;
}

/**
 * The field from the PNG's pixels (RGBA, as a canvas gives them): the
 * eastward solution's square stacked over the southward one's, each in R
 * and G, with the land in the top square's B.
 */
export function unpackField(
  rgba: ArrayLike<number>,
  width: number,
  height: number
): WindField {
  if (height !== width * 2) {
    throw new Error(`wind field: ${width}×${height}, not two squares`);
  }

  const size = width;
  const cells = size * size;
  const data = new Uint8Array(cells * 4);
  const land = new Uint8Array(cells);

  for (let i = 0; i < cells; i++) {
    const south = cells + i;
    data[i * 4] = rgba[i * 4];
    data[i * 4 + 1] = rgba[i * 4 + 1];
    data[i * 4 + 2] = rgba[south * 4];
    data[i * 4 + 3] = rgba[south * 4 + 1];
    land[i] = rgba[i * 4 + 2];
  }

  return { size, data, land };
}

const decode = (byte: number) => (byte - 128) / FIELD_SCALE;

/**
 * The surface flow (x east, z south), m/s, at world x/z under a wind of
 * (wx, wz) out at sea, filtered as the GPU does: bilinear between cell
 * centres, clamped at the edges.
 */
export function flowAt(
  { size, data }: WindField,
  rootSize: number,
  x: number,
  z: number,
  wx: number,
  wz: number
): [number, number] {
  const u = ((x + rootSize / 2) / rootSize) * size - 0.5;
  const v = ((z + rootSize / 2) / rootSize) * size - 0.5;
  const clamp = (n: number) => Math.min(Math.max(n, 0), size - 1);
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const out: [number, number] = [0, 0];

  for (const [di, dj, weight] of [
    [0, 0, (1 - fu) * (1 - fv)],
    [1, 0, fu * (1 - fv)],
    [0, 1, (1 - fu) * fv],
    [1, 1, fu * fv],
  ]) {
    const p = (clamp(j + dj) * size + clamp(i + di)) * 4;
    out[0] += weight * (decode(data[p]) * wx + decode(data[p + 2]) * wz);
    out[1] += weight * (decode(data[p + 1]) * wx + decode(data[p + 3]) * wz);
  }

  return out;
}

function byteTexture(data: Uint8Array, size: number, format: PixelFormat) {
  const texture = new DataTexture(data, size, size, format, UnsignedByteType);

  texture.magFilter = texture.minFilter = LinearFilter;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return texture;
}

/** The flows as a texture, and the land as another, both filtered. */
export function fieldTextures({ size, data, land }: WindField) {
  return {
    flow: byteTexture(data, size, RGBAFormat),
    land: byteTexture(land, size, RedFormat),
  };
}

export async function loadWindField(): Promise<WindField> {
  const response = await fetch(FIELD_URL);

  if (!response.ok) throw new Error(`wind field: ${response.status}`);

  // The bytes are numbers, so no colour management.
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });

  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) throw new Error("no 2D canvas context");

  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  return unpackField(
    context.getImageData(0, 0, width, height).data,
    width,
    height
  );
}
