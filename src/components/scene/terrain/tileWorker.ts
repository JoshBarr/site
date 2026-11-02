// Fetches and decodes terrain tiles off the main thread.
// Request: { id, url, offset, scale }
// Response: { id, heights: Float32Array, ground: Uint8Array } | { id, error: string }
//
// ground interleaves relief (0..254, 127 level) and building cover (0 or 255).

interface DecodeRequest {
  id: number;
  url: string;
  offset: number;
  scale: number;
}

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

async function decode({ url, offset, scale }: DecodeRequest) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }

  // Heights are split across bytes, so the image must arrive untouched:
  // no colour management, no premultiplication.
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });

  const { width, height } = bitmap;

  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }

  if (!ctx) throw new Error("no 2D canvas context");

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const rgba = ctx.getImageData(0, 0, width, height).data;
  const heights = new Float32Array(width * height);
  const ground = new Uint8Array(width * height * 2);

  for (let i = 0; i < heights.length; i++) {
    const q = (rgba[i * 4] << 8) | rgba[i * 4 + 1];
    heights[i] = q / scale - offset;
    // B packs 7 bits of relief over a building bit.
    const b = rgba[i * 4 + 2];
    ground[i * 2] = (b >> 1) * 2;
    ground[i * 2 + 1] = (b & 1) * 255;
  }

  return { heights, ground };
}

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { id } = event.data;

  try {
    const { heights, ground } = await decode(event.data);
    self.postMessage(
      { id, heights, ground },
      { transfer: [heights.buffer, ground.buffer] }
    );
  } catch (e) {
    self.postMessage({ id, error: String(e) });
  }
};
