import { deflateSync } from "node:zlib";

// PNGs for tests, each row filtered by a different one of PNG's five
// filters in turn, so a decoder has to undo them all.

function chunk(name: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(name, 4, "latin1");
  out.set(data, 8);

  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);

  return out;
}

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;

  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

  return c >>> 0;
});

function crc(bytes: Uint8Array) {
  let c = 0xffffffff;

  for (const byte of bytes) c = table[(c ^ byte) & 255] ^ (c >>> 8);

  return (c ^ 0xffffffff) >>> 0;
}

function paeth(left: number, up: number, corner: number) {
  const p = left + up - corner;
  const a = Math.abs(p - left);
  const b = Math.abs(p - up);
  const c = Math.abs(p - corner);

  return a <= b && a <= c ? left : b <= c ? up : corner;
}

/**
 * A PNG of `pixels` (`channels` bytes each, row by row): colour type `type`,
 * with `palette` and `alpha` (tRNS) for type 3.
 */
export function encodePng(
  width: number,
  height: number,
  pixels: Uint8Array,
  {
    type,
    palette,
    alpha,
  }: { type: 0 | 2 | 3 | 6; palette?: Uint8Array; alpha?: Uint8Array }
) {
  const channels = { 0: 1, 2: 3, 3: 1, 6: 4 }[type];
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;

    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= channels ? pixels[at - channels] : 0;
      const up = y ? pixels[at - stride] : 0;
      const corner = y && x >= channels ? pixels[at - stride - channels] : 0;

      const guess = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][
        filter
      ];

      raw[y * (stride + 1) + 1 + x] = (pixels[at] - guess) & 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, type, 0, 0, 0], 8);

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...(palette ? [chunk("PLTE", palette)] : []),
    ...(alpha ? [chunk("tRNS", alpha)] : []),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}
