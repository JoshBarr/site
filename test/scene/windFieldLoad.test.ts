import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../msw";

// The wind field's loaded once, however many layers ask for it: the
// trails, the sea and the fountain all do.

const ORIGIN = "http://localhost:3000";

/** A field two cells across: the eastward square over the southward one. */
const WIDTH = 2;
const HEIGHT = 4;

const PIXELS = Uint8ClampedArray.from(
  { length: WIDTH * HEIGHT * 4 },
  (_, i) => i
);

/** Serves the field, as `answers` has it each time, and counts the asks. */
function serve(...answers: number[]) {
  const asked = { count: 0 };

  server.use(
    http.get(`${ORIGIN}/wind/field.png`, () => {
      const status = answers[Math.min(asked.count, answers.length - 1)];

      asked.count++;

      return new HttpResponse(new Uint8Array(1), { status });
    })
  );

  return asked;
}

const load = async () =>
  (await import("../../src/components/scene/wind/field")).loadWindField;

beforeEach(() => {
  vi.resetModules();

  // Node fetches whole URLs only; the browser decodes the PNG, not Node.
  const fetched = globalThis.fetch;

  vi.stubGlobal("fetch", (url: string) => fetched(new URL(url, ORIGIN)));

  vi.stubGlobal("createImageBitmap", async () => ({
    width: WIDTH,
    height: HEIGHT,
    close() {},
  }));

  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return { drawImage() {}, getImageData: () => ({ data: PIXELS }) };
      }
    }
  );
});

describe("loading the wind field", () => {
  it("fetches it once for everything that asks", async () => {
    const asked = serve(200);
    const loadWindField = await load();

    const [trails, sea, fountain] = await Promise.all([
      loadWindField(),
      loadWindField(),
      loadWindField(),
    ]);

    expect(asked.count).toBe(1);
    expect(sea).toBe(trails);
    expect(fountain).toBe(trails);
    expect(await loadWindField()).toBe(trails);
    expect(asked.count).toBe(1);
    expect(trails.size).toBe(WIDTH);
  });

  it("asks again after a load that failed", async () => {
    const asked = serve(500, 200);
    const loadWindField = await load();

    await expect(loadWindField()).rejects.toThrow("wind field: 500");

    const field = await loadWindField();

    expect(asked.count).toBe(2);
    expect(field.size).toBe(WIDTH);
  });
});
