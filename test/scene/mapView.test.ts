import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EDGE,
  edgeCursor,
  edgePan,
  getMapView,
  setMapView,
  subscribeMapView,
  toggleMapView,
} from "../../src/components/scene/mapView";

afterEach(() => setMapView(false));

describe("map view", () => {
  it("switches on and off, telling whoever's listening only on a change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMapView(listener);

    expect(getMapView()).toBe(false);
    toggleMapView();
    expect(getMapView()).toBe(true);
    setMapView(true);
    expect(listener).toHaveBeenCalledTimes(1);

    toggleMapView();
    expect(getMapView()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    toggleMapView();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  describe("at the edge of the view", () => {
    const [w, h] = [1000, 600];

    it("pans nowhere away from the edges", () => {
      expect(edgePan(500, 300, w, h)).toEqual({ right: 0, up: 0 });
      expect(edgePan(EDGE + 1, h - EDGE - 1, w, h)).toEqual({
        right: 0,
        up: 0,
      });
      expect(edgeCursor({ right: 0, up: 0 })).toBe("");
    });

    it("pans toward the edge the mouse is at, harder the closer", () => {
      expect(edgePan(w, 300, w, h)).toEqual({ right: 1, up: 0 });
      expect(edgePan(0, 300, w, h)).toEqual({ right: -1, up: 0 });
      expect(edgePan(500, 0, w, h)).toEqual({ right: 0, up: 1 });
      expect(edgePan(500, h, w, h)).toEqual({ right: 0, up: -1 });

      const halfway = edgePan(w - EDGE / 2, 300, w, h).right;
      expect(halfway).toBeCloseTo(0.5);
    });

    it("pans diagonally in the corners, the cursor pointing the way", () => {
      const corner = edgePan(w - 1, 1, w, h);

      expect(corner.right).toBeGreaterThan(0.9);
      expect(corner.up).toBeGreaterThan(0.9);
      expect(edgeCursor(corner)).toBe("ne-resize");
      expect(edgeCursor(edgePan(0, h, w, h))).toBe("sw-resize");
      expect(edgeCursor(edgePan(500, h, w, h))).toBe("s-resize");
    });

    it("keeps to a narrower edge in a small view", () => {
      expect(edgePan(30, 50, 100, 100)).toEqual({ right: 0, up: 0 });
    });
  });
});
