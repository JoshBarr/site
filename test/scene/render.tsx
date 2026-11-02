import { readFile } from "node:fs/promises";
import { useFrame } from "@react-three/fiber";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { http, HttpResponse } from "msw/http";
import { ImageLoader, Object3D, WebGPURenderer } from "three/webgpu";
import { vi } from "vitest";
import type { Aircraft } from "../../src/lib/flights";
import { STALE } from "../../src/lib/traffic";
import { loadManifest } from "../../src/components/scene/terrain/manifest";
import type { Conditions } from "../../src/components/scene/weather";
import { CAMERA, Scene } from "../../src/components/scene/WellingtonScene";
import { server } from "../msw";

/** happy-dom's page: the scene's relative URLs resolve against it. */
const ORIGIN = "http://localhost:3000";

/** A fair-weather northerly, as the scene has before the forecast arrives. */
const FAIR: Conditions = {
  time: new Date(0).toISOString(),
  cloudCover: 0.35,
  cloudBase: 900,
  visibility: 30000,
  humidity: 0.7,
  precipitation: 0,
  wind: { speed: 7, direction: 340 },
  windAloft: { speed: 10, direction: 340 },
};

/** Stands in for the terrain's and clouds' workers; it never answers. */
class IdleWorker extends EventTarget {
  onmessage = null;
  postMessage() {}
  terminate() {}
}

/**
 * The site as the scene sees it: the data and tiles in public/, read from
 * disk, and the live APIs with nothing moving but `aircraft`.
 */
function serve(aircraft: Aircraft[]) {
  server.use(
    http.get(`${ORIGIN}/api/flights`, () =>
      HttpResponse.json({ time: Date.now(), aircraft })
    ),
    http.get(`${ORIGIN}/api/vessels`, () =>
      HttpResponse.json({ time: Date.now(), vessels: [] })
    ),
    http.get(`${ORIGIN}/api/trains`, () =>
      HttpResponse.json({ time: Date.now(), trains: [] })
    ),
    http.get(`${ORIGIN}/api/buses`, () =>
      HttpResponse.json({ time: Date.now(), buses: [] })
    ),
    // Long stale: traffic runs at its own speeds.
    http.get(`${ORIGIN}/api/traffic`, () =>
      HttpResponse.json({
        time: Date.now(),
        fetched: Date.now() - 2 * STALE,
        links: {},
        legs: {},
      })
    ),
    http.get(`${ORIGIN}/*`, async ({ request }) => {
      const path = decodeURIComponent(new URL(request.url).pathname);

      try {
        return new HttpResponse(await readFile(`public${path}`));
      } catch {
        return new HttpResponse(null, { status: 404 });
      }
    })
  );
}

/**
 * The renderer, without a GPU: it's never initialised, and drawing and
 * compute do nothing. The layers build their objects as they would.
 */
function createRenderer({
  canvas,
}: {
  canvas: HTMLCanvasElement | OffscreenCanvas;
}) {
  // SAFETY: test-renderer's canvas is the DOM's; WebGPURenderer's parameter
  // is typed against another declaration of OffscreenCanvas.
  const renderer = new WebGPURenderer({ canvas: canvas as HTMLCanvasElement });
  vi.spyOn(renderer, "render").mockImplementation(() => {});
  vi.spyOn(renderer, "compute").mockImplementation(() => undefined);

  return renderer;
}

/**
 * What drawing would do to the scene graph, after everything else in the
 * frame: bring its matrices up to date for the next frame to read (the
 * camera's frustum, for one).
 */
function Drawn() {
  useFrame(({ scene, camera }) => {
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
  }, 100);

  return null;
}

/** Whether it's drawn: it and everything above it visible. */
export function shown(object: Object3D) {
  for (let o: Object3D | null = object; o; o = o.parent) {
    if (!o.visible) return false;
  }

  return true;
}

/**
 * The whole scene at `time`, in fair weather, mounted without a Canvas. `drawn(name)` finds
 * what's in it; `until` runs frames while tiles and data arrive.
 */
export async function renderScene(time: Date, aircraft: Aircraft[] = []) {
  vi.stubGlobal("Worker", IdleWorker);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  // Images never load in happy-dom; textures get an empty one.
  vi.spyOn(ImageLoader.prototype, "load").mockImplementation((_url, onLoad) => {
    const image = document.createElement("img");
    queueMicrotask(() => onLoad?.(image));

    return image;
  });

  serve(aircraft);
  const index = await loadManifest();

  const renderer = await ReactThreeTestRenderer.create(
    <>
      <Scene index={index} conditions={FAIR} time={time} mobile={false} />
      <Drawn />
    </>,
    { gl: createRenderer, camera: CAMERA }
  );

  // SAFETY: the root of test-renderer's tree is the THREE.Scene.
  const scene = renderer.scene.instance as Object3D;
  const drawn = (name: string) => scene.getObjectsByProperty("name", name);

  /** Frames, a few ms apart, until `done` (or it gives up). */
  const until = async (done: () => boolean, timeout = 10_000) => {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      await renderer.advanceFrames(1, 1 / 60);

      if (done()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error("the scene didn't settle");
  };

  const unmount = async () => {
    await renderer.unmount();
    vi.unstubAllGlobals();
  };

  return { scene, drawn, until, unmount };
}
