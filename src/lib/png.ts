import { inflateSync } from "node:zlib";

// Just enough PNG to read satellite tiles (./cloudMap.ts): 8-bit grey,
// palette, RGB and RGBA, not interlaced.

export interface Image {
  width: number;
  height: number;
  /** Four bytes a pixel, RGBA, row by row from the top. */
  rgba: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Bytes a pixel, by colour type. */
const CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);

export function decodePng(file: Uint8Array): Image {
  if (SIGNATURE.some((byte, i) => file[i] !== byte)) {
    throw new Error("png: not a PNG");
  }

  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const compressed: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let type = -1;
  let palette: Uint8Array = new Uint8Array();
  let alpha: Uint8Array = new Uint8Array();

  for (let at = 8; at + 8 <= file.length;) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const start = at + 8;
    const data = file.subarray(start, start + length);

    at = start + length + 4;

    if (name === "IHDR") {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const depth = data[8];
      type = data[9];

      if (depth !== 8 || data[12] !== 0 || !CHANNELS.has(type)) {
        throw new Error(`png: can't read depth ${depth}, type ${type}`);
      }
    } else if (name === "PLTE") palette = data;
    else if (name === "tRNS") alpha = data;
    else if (name === "IDAT") compressed.push(data);
    else if (name === "IEND") break;
  }

  const channels = CHANNELS.get(type) ?? 1;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(compressed));

  if (raw.length < height * (stride + 1)) throw new Error("png: too short");

  const pixels = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * stride;

    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[line + x - channels] : 0;
      const up = y ? pixels[line - stride + x] : 0;

      const corner =
        y && x >= channels ? pixels[line - stride + x - channels] : 0;

      let guess = 0;

      if (filter === 1) guess = left;
      else if (filter === 2) guess = up;
      else if (filter === 3) guess = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const toLeft = Math.abs(p - left);
        const toUp = Math.abs(p - up);
        const toCorner = Math.abs(p - corner);

        guess =
          toLeft <= toUp && toLeft <= toCorner
            ? left
            : toUp <= toCorner
              ? up
              : corner;
      }

      pixels[line + x] = (value + guess) & 255;
    }
  }

  const rgba = new Uint8Array(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const out = i * 4;

    if (type === 3) {
      const index = pixels[i];
      rgba.set(palette.subarray(index * 3, index * 3 + 3), out);
      rgba[out + 3] = index < alpha.length ? alpha[index] : 255;
    } else if (type === 0 || type === 4) {
      const grey = pixels[i * channels];
      rgba.fill(grey, out, out + 3);
      rgba[out + 3] = type === 4 ? pixels[i * 2 + 1] : 255;
    } else {
      rgba.set(pixels.subarray(i * channels, i * channels + 3), out);
      rgba[out + 3] = type === 6 ? pixels[i * 4 + 3] : 255;
    }
  }

  return { width, height, rgba };
}
