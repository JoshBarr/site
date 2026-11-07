// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSceneTime } from "../../src/components/scene/clock";
import {
  cloudField,
  FIELD_SIZE,
  pullFor,
  setCloudField,
} from "../../src/components/scene/clouds/cloudField";
import { useSeenClouds } from "../../src/components/scene/clouds/seenClouds";
import type { CloudMap } from "../../src/lib/cloudMap";
import { NOW } from "../clock";
import { server } from "../msw";

// Where the satellite saw cloud, fetched for the scene and shared out over
// the map: the cover piles up where it saw cloud, and its pull fades as the
// scan ages.

const ORIGIN = "http://localhost:3000";

const MINUTE = 60_000;

/** Cloudy over the west half of the map, clear over the east. */
const westCloudy = Uint8Array.from({ length: FIELD_SIZE ** 2 }, (_, k) =>
  k % FIELD_SIZE < FIELD_SIZE / 2 ? 255 : 0
);

const scan = (time: number, cells = westCloudy): CloudMap => ({
  time,
  product: "visible",
  cells: Buffer.from(cells).toString("base64"),
});

/** Lets requests in flight be answered, under the fake timers. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(0);
    }
  });

function answer(clouds: () => Response) {
  const asked: string[] = [];

  server.use(
    http.get(`${ORIGIN}/api/clouds`, ({ request }) => {
      asked.push(request.url);

      return clouds();
    })
  );

  return asked;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  setSceneTime(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  setSceneTime(null);
  setCloudField(null);
  history.replaceState(null, "", "/");
});

describe("the satellite's clouds", () => {
  it("are what it saw, once fetched", async () => {
    answer(() => HttpResponse.json(scan(NOW - 20 * MINUTE)));

    const { result } = renderHook(() => useSeenClouds());

    expect(result.current).toBeNull();

    await settle();

    expect(result.current).toEqual({
      time: NOW - 20 * MINUTE,
      cells: westCloudy,
    });
  });

  it("are nothing when the scan's old, or the wrong size", async () => {
    answer(() => HttpResponse.json(scan(NOW - 3 * 3600_000)));

    const { result } = renderHook(() => useSeenClouds());

    await settle();

    expect(result.current).toBeNull();

    cleanup();
    answer(() => HttpResponse.json(scan(NOW, Uint8Array.from([1, 2, 3]))));

    const again = renderHook(() => useSeenClouds());

    await settle();

    expect(again.result.current).toBeNull();
  });

  it("aren't asked for with the sky tried out, or switched off", async () => {
    const asked = answer(() => HttpResponse.json(scan(NOW)));

    for (const search of ["?cloud=80", "?base=600", "?off=cloudmap"]) {
      history.replaceState(null, "", `/${search}`);
      renderHook(() => useSeenClouds());
      await settle();
      cleanup();
    }

    expect(asked).toEqual([]);
  });
});

describe("the cloud field", () => {
  it("shares the cover out to where the cloud was, averaging the same", () => {
    expect(setCloudField({ time: NOW, cells: westCloudy }, 10 * MINUTE)).toBe(
      0.85
    );

    // Half the map's cloudy: there, twice the cover; elsewhere, none.
    expect(cloudField.boost.value).toBeCloseTo(2);
  });

  it("doesn't gather the cover into a few bright cells", () => {
    const speck = new Uint8Array(FIELD_SIZE ** 2);
    speck[0] = 255;

    setCloudField({ time: NOW, cells: speck });

    expect(cloudField.boost.value).toBeCloseTo(1 / 0.08);
  });

  it("pulls less as the scan ages, and not at all without one", () => {
    expect(pullFor(30 * MINUTE)).toBe(0.85);
    expect(pullFor(80 * MINUTE)).toBeCloseTo(0.85 / 2);
    expect(pullFor(3 * 3600_000)).toBe(0);
    expect(setCloudField(null)).toBe(0);
    expect(cloudField.pull.value).toBe(0);
  });
});
