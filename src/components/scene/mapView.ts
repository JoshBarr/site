import { useSyncExternalStore } from "react";

// Map view: the camera high over the city at a fixed angle, facing north,
// panned about like an old strategy game's battlefield, by dragging, the
// keys, or holding the mouse at the edge of the view. The clouds are left
// out, since it looks down through them.

/** From straight down, the angle the map's looked at, radians. */
export const MAP_POLAR_ANGLE = (48 * Math.PI) / 180;

/** Camera to the ground it's aimed at, m, to start with. */
export const MAP_DISTANCE = 7500;

/**
 * And the zoom's limits: in close, the camera's ~200 m up, over the CBD's
 * tallest towers.
 */
export const MAP_ZOOM: [number, number] = [300, 16000];

/** Within this many pixels of the edge of the view, the mouse pans the map. */
export const EDGE = 28;

/** Panning at the very edge, this many times the camera's distance a second. */
export const EDGE_SPEED = 0.35;

let on =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("map");

const listeners = new Set<() => void>();

export const getMapView = () => on;

export function setMapView(next: boolean) {
  if (next === on) return;
  on = next;
  listeners.forEach((listener) => listener());
}

export const toggleMapView = () => setMapView(!on);

export function subscribeMapView(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export const useMapView = () =>
  useSyncExternalStore(subscribeMapView, getMapView, () => false);

/**
 * How hard the mouse at (x, y) in a w × h view pans the map: right and up
 * (toward the top of the view), each −1..1, ramping up over the last EDGE
 * pixels. Zero away from the edges.
 */
export function edgePan(x: number, y: number, w: number, h: number) {
  const push = (at: number, size: number) => {
    const zone = Math.min(EDGE, size / 4);

    if (at < zone) return -(1 - Math.max(at, 0) / zone);

    if (at > size - zone) return 1 - Math.max(size - at, 0) / zone;

    return 0;
  };

  return { right: push(x, w), up: 0 - push(y, h) };
}

/** The cursor that says which way the edge is panning. */
export function edgeCursor({ right, up }: { right: number; up: number }) {
  const ns = up > 0 ? "n" : up < 0 ? "s" : "";
  const ew = right > 0 ? "e" : right < 0 ? "w" : "";

  return ns || ew ? `${ns}${ew}-resize` : "";
}
