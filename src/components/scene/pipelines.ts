import { useLayoutEffect } from "react";
import { addLoadingSource, countLoaded, hasFirstViewLoaded } from "./loading";
import { useRenderer } from "./renderer";
import { switchedOff } from "./stats";

/**
 * Pipelines compiling at once, at most one for every two cores. Each takes
 * a GPU process worker thread and macOS's Metal compiler 0.3–1.2 s on a
 * first visit. A hundred at once left nothing for Chrome's own compositing,
 * and the page stopped for 2 s while it waited. On the M1, a first visit
 * showed the scene at 16.7 s one at a time, 10.1 s two, 9.2 s four, and
 * 9.0 s eight at a time, with a 434 ms frame.
 */
const MAX_COMPILING = 4;

function compileSlots() {
  const cores = navigator.hardwareConcurrency || 4;

  return Math.max(1, Math.min(MAX_COMPILING, Math.floor(cores / 2)));
}

/**
 * Has the scene's pipelines compile in the background, a few at a time,
 * and each drawn from the first frame it's ready.
 *
 * three creates render pipelines with WebGPU's synchronous
 * createRenderPipeline when they're first drawn. The GPU process compiles
 * each before it does anything else, so the page's next buffer or texture
 * upload waits on it: on a first visit, with nothing in the shader cache, a
 * hundred of them froze the page for a second or two at a time. Made with
 * createRenderPipelineAsync, as three's compileAsync() makes them, they
 * compile on the GPU process's workers, and three skips a draw until its
 * pipeline's ready (see Renderer._renderObjectDirect). A first visit on the
 * M1 went from 12.6 s of long frames (one of 5.7 s) to 1 s (none over
 * 300 ms). Measure it with the shaders salted, or the Metal shader cache
 * from earlier loads hides it.
 *
 * The full-screen passes, the clouds and the composite, stay synchronous
 * once the first view's in: one skipped would blank the frame, as when
 * they're rebuilt at dusk or when the rain starts. Until then nobody sees
 * the scene. Compute pipelines are synchronous too, since three dispatches
 * them ready or not: precompile them with compileComputeAsync().
 *
 * Pipelines compiling or waiting to count as loading, so the first view
 * isn't shown with things missing from it. Returns a function that puts
 * three's own way back.
 */
export function compileInBackground(renderer: { backend: unknown }) {
  // SAFETY: the backend's internals are untyped. WebGPUBackend's
  // createRenderPipeline takes a render object and, from compileAsync(), an
  // array for the compiles' promises, made asynchronously when it's given.
  const backend = renderer.backend as any;

  // The WebGL fallback has nothing to gain. ?off=compile measures what it
  // saves.
  if (backend.isWebGPUBackend !== true || switchedOff("compile")) {
    return () => {};
  }

  const device: GPUDevice = backend.device;
  const slots = compileSlots();
  let compiling = 0;
  const waiting: (() => void)[] = [];

  /** Runs `compile` once there's room, and the next waiting when it's done. */
  function limited<T>(compile: () => Promise<T>): Promise<T> {
    const run = () => {
      compiling++;

      return compile().finally(() => {
        compiling--;
        countLoaded();
        waiting.shift()?.();
      });
    };

    if (compiling < slots) return run();

    return new Promise<T>((resolve, reject) => {
      waiting.push(() => run().then(resolve, reject));
    });
  }

  const ownRender = device.createRenderPipelineAsync;
  const ownCompute = device.createComputePipelineAsync;

  // Each from a copy of its descriptor as it is now: three has one of each
  // that it resets as soon as the call returns, its multisample state in
  // place. The rest are new objects for every pipeline.
  device.createRenderPipelineAsync = (descriptor) => {
    const copy = {
      ...descriptor,
      multisample: descriptor.multisample && { ...descriptor.multisample },
    };

    return limited(() => ownRender.call(device, copy));
  };

  device.createComputePipelineAsync = (descriptor) => {
    const copy = { ...descriptor };

    return limited(() => ownCompute.call(device, copy));
  };

  const ownPipeline = backend.createRenderPipeline;

  backend.createRenderPipeline = (
    renderObject: { context: { fullscreenPass?: boolean } },
    promises: Promise<void>[] | null
  ) => {
    // compileAsync()'s own, and a pass that's better late than blank.
    const asIs =
      promises !== null ||
      (renderObject.context.fullscreenPass === true && hasFirstViewLoaded());

    // The promises only tell compileAsync() when they're done: three skips
    // the draw until then all the same.
    ownPipeline.call(backend, renderObject, asIs ? promises : []);
  };

  const remove = addLoadingSource(
    () => compiling,
    () => waiting.length
  );

  return () => {
    device.createRenderPipelineAsync = ownRender;
    device.createComputePipelineAsync = ownCompute;
    backend.createRenderPipeline = ownPipeline;
    remove();
  };
}

/**
 * See compileInBackground: for as long as it's mounted in the Canvas,
 * before anything's drawn.
 */
export function CompileInBackground() {
  const renderer = useRenderer();

  useLayoutEffect(() => compileInBackground(renderer), [renderer]);

  return null;
}
