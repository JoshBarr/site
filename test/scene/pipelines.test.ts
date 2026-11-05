// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

// The scene's pipelines compile in the background, a few at a time, and
// count as loading while they do. What's loading is kept in a module, so
// each test imports it afresh.

async function load() {
  vi.resetModules();

  return {
    ...(await import("../../src/components/scene/loading")),
    ...(await import("../../src/components/scene/pipelines")),
  };
}

/** The pipelines made each way, by label. */
interface Made {
  sync: string[];
  async: string[];
}

/** A pipeline compile the test finishes when it likes. */
interface Compile {
  descriptor: { label: string; multisample?: { count: number } };
  finish: () => void;
}

/**
 * A renderer whose backend makes pipelines the way three's WebGPUBackend
 * does: synchronously unless it's given an array for the promises, then
 * with the device's createRenderPipelineAsync. Like three's, its one
 * descriptor is reset when the call returns.
 */
function fakeRenderer() {
  const compiles: Compile[] = [];
  const made: Made = { sync: [], async: [] };
  const descriptor = { label: "", multisample: { count: 1 } };

  const compile = (d: Compile["descriptor"]) =>
    new Promise<object>((resolve) => {
      compiles.push({ descriptor: d, finish: () => resolve({}) });
    });

  const device = {
    createRenderPipelineAsync: compile,
    createComputePipelineAsync: compile,
  };

  const backend = {
    isWebGPUBackend: true,
    device,
    createRenderPipeline(
      renderObject: { label: string; context: { fullscreenPass: boolean } },
      promises: Promise<void>[] | null
    ) {
      descriptor.label = renderObject.label;
      descriptor.multisample.count = 4;

      if (promises === null) {
        made.sync.push(renderObject.label);
      } else {
        made.async.push(renderObject.label);
        promises.push(this.device.createRenderPipelineAsync(descriptor));
      }

      descriptor.label = "";
      descriptor.multisample.count = 1;
    },
  };

  const renderer = { backend };

  const draw = (label: string, fullscreenPass = false) =>
    backend.createRenderPipeline({ label, context: { fullscreenPass } }, null);

  return { renderer, backend, device, compiles, made, draw };
}

/** Lets the compiles' promise chains run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compiling in the background", () => {
  it("makes what's drawn asynchronously, from a copy of its descriptor", async () => {
    const l = await load();
    const fake = fakeRenderer();

    l.compileInBackground(fake.renderer);
    fake.draw("terrain");

    expect(fake.made).toEqual({ sync: [], async: ["terrain"] });
    // Not the one three's since reset.
    expect(fake.compiles[0].descriptor).toEqual({
      label: "terrain",
      multisample: { count: 4 },
    });
  });

  it("compiles a few at a time, and counts them all as loading", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    const l = await load();
    const fake = fakeRenderer();

    l.compileInBackground(fake.renderer);

    for (let i = 0; i < 6; i++) fake.draw(`layer ${i}`);

    expect(fake.compiles).toHaveLength(4);
    expect(l.loadingCount()).toBe(4);
    expect(l.loadedShare()).toBe(0);

    // One done, the next starts.
    fake.compiles[0].finish();
    await settle();

    expect(fake.compiles).toHaveLength(5);
    expect(fake.compiles[4].descriptor.label).toBe("layer 4");
    expect(l.loadedShare()).toBeCloseTo(1 / 6);

    for (const c of fake.compiles.slice(1)) c.finish();
    await settle();
    fake.compiles[5].finish();
    await settle();

    expect(l.loadingCount()).toBe(0);
    expect(l.loadedShare()).toBe(1);
  });

  it("takes fewer at once on fewer cores", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
    const l = await load();
    const fake = fakeRenderer();

    l.compileInBackground(fake.renderer);

    for (let i = 0; i < 3; i++) fake.draw(`layer ${i}`);

    expect(fake.compiles).toHaveLength(1);
  });

  it("makes full-screen passes as they are once the first view's in", async () => {
    const l = await load();
    const fake = fakeRenderer();

    l.compileInBackground(fake.renderer);
    fake.draw("clouds", true);
    l.finishFirstView();
    fake.draw("composite at dusk", true);
    fake.draw("night lights");

    expect(fake.made).toEqual({
      sync: ["composite at dusk"],
      async: ["clouds", "night lights"],
    });
  });

  it("leaves compileAsync's own pipelines to it", async () => {
    const l = await load();
    const fake = fakeRenderer();
    const promises: Promise<void>[] = [];

    l.compileInBackground(fake.renderer);
    fake.backend.createRenderPipeline(
      { label: "precompiled", context: { fullscreenPass: false } },
      promises
    );

    expect(promises).toHaveLength(1);
  });

  it("puts three's own way back", async () => {
    const l = await load();
    const fake = fakeRenderer();
    const { createRenderPipeline } = fake.backend;
    const { createRenderPipelineAsync } = fake.device;

    const restore = l.compileInBackground(fake.renderer);
    restore();

    expect(fake.backend.createRenderPipeline).toBe(createRenderPipeline);
    expect(fake.device.createRenderPipelineAsync).toBe(
      createRenderPipelineAsync
    );
    fake.draw("terrain");
    expect(fake.made.sync).toEqual(["terrain"]);
  });

  it("leaves the WebGL fallback alone", async () => {
    const l = await load();
    const fake = fakeRenderer();
    fake.backend.isWebGPUBackend = false;
    const { createRenderPipeline } = fake.backend;

    l.compileInBackground(fake.renderer);

    expect(fake.backend.createRenderPipeline).toBe(createRenderPipeline);
  });
});
