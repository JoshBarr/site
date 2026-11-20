import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
} from "three/webgpu";
import { float, sqrt, texture, uniform } from "three/tsl";
import { exposing, type Incoming, SHELTER_SIZE } from "./shelter";

// The open sea's reach (./shelter.ts) as the surface reads it: a map over
// the terrain's root of how exposed each stretch of water is, worked out
// again when the sea turns, and how much of the longest cascade is the open
// sea's to lose.

/** The sea's direction is followed to this, degrees: a turn of less isn't seen. */
const TURN = 5;

function byteMap(bytes: Uint8Array) {
  const texture = new DataTexture(
    bytes,
    SHELTER_SIZE,
    SHELTER_SIZE,
    RedFormat,
    UnsignedByteType
  );

  texture.magFilter = texture.minFilter = LinearFilter;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return texture;
}

// Until the depths are in, the open sea everywhere, as it was before.
const data = new Uint8Array(SHELTER_SIZE * SHELTER_SIZE).fill(255);

const map = byteMap(data);

/** How much of the longest cascade's energy is the open sea's alone. */
const openShare = uniform(0);

let depths: { depth: Float32Array; cell: number } | null = null;

let incoming: (Incoming & { open: number }) | null = null;

/** What the map's drawn for, or being drawn for. */
let drawn = "";

/** The drawing under way: a newer one takes its place. */
let drawing: Iterator<void> | null = null;

/** Carries a drawing on a step, then the next a moment later, to its end. */
function carryOn(steps: Iterator<void>) {
  if (steps !== drawing) return;

  if (steps.next().done) {
    drawing = null;
    map.needsUpdate = true;

    return;
  }

  setTimeout(carryOn, 0, steps);
}

function draw() {
  if (!incoming) return;

  openShare.value = depths ? incoming.open : 0;

  if (!depths) return;

  const from = Math.round(incoming.from / TURN) * TURN;
  // Longer than this, and the bottom's felt no deeper (./shelter.ts).
  const length = Math.min(Math.round(incoming.length / 4) * 4, 120);
  const key = `${from}|${length}|${incoming.grows ?? 0}`;

  if (key === drawn) return;

  const first = drawn === "";

  drawn = key;

  drawing = exposing(
    depths.depth,
    depths.cell,
    { ...incoming, from, length },
    data
  );

  if (first) {
    // The scene's still loading, and there's no map yet to make do with.
    while (!drawing.next().done);

    drawing = null;
    map.needsUpdate = true;

    return;
  }

  // The map's the old sea's until the new one's whole: a step a turn of
  // the event loop, so no frame waits for all of it.
  carryOn(drawing);
}

/** The sea the map's for: where it's from, and how much of the surface is it. */
export function setIncoming(sea: Incoming & { open: number }) {
  incoming = sea;
  draw();
}

/**
 * Reads the water's depths out of the terrain's depth map (`image`, row 0
 * its northern edge, each byte a depth as `decode` reads it, 0 on land)
 * over a root `rootSize` metres a side. Without a canvas to read it with,
 * the sea's left unsheltered.
 */
export function readDepths(
  image: CanvasImageSource & { width: number },
  rootSize: number,
  decode: (byte: number) => number
) {
  try {
    let source: CanvasImageSource = image;
    let size = image.width;
    let context: CanvasRenderingContext2D | null = null;

    // Halved at a time, so each cell's the mean of all it covers.
    do {
      size = Math.max(Math.floor(size / 2), SHELTER_SIZE);

      const canvas = document.createElement("canvas");

      canvas.width = canvas.height = size;
      context = canvas.getContext("2d", { willReadFrequently: true });

      if (!context) throw new Error("no 2D canvas");

      context.drawImage(source, 0, 0, size, size);
      source = canvas;
    } while (size > SHELTER_SIZE);

    const { data: pixels } = context.getImageData(0, 0, size, size);
    const depth = new Float32Array(SHELTER_SIZE * SHELTER_SIZE);

    for (let i = 0; i < depth.length; i++) depth[i] = decode(pixels[i * 4]);

    depths = { depth, cell: rootSize / SHELTER_SIZE };
    drawn = "";
    draw();
  } catch (e) {
    console.warn("[sea shelter] the depths can't be read:", e);
  }
}

/**
 * How high the longest cascade stands at world `xz`, against the open
 * sea's. For the vertex stage; pass it on to the fragment's in a varying.
 */
export function seaStanding(xz, rootSize: number) {
  const exposed = texture(map, xz.add(rootSize / 2).div(rootSize)).level(
    float(0)
  ).r;

  // As ./shelter.ts's `standing`.
  return sqrt(float(1).sub(openShare.mul(float(1).sub(exposed.mul(exposed)))));
}
