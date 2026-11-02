import { BufferAttribute } from "three/webgpu";

// One tree, shaped per instance in the vertex shader (see material.ts): a
// crown of rings around a vertical axis, with a pole at each end, and a
// trunk. Each vertex carries where it sits on that frame, not a position.

/** Around the crown. Odd rings turn half a step, so facets zig-zag. */
const SEGMENTS = 6;
/** Up the crown, 0 its base, 1 its top. */
const RINGS = [0.2, 0.5, 0.8];
const TRUNK_SIDES = 3;

/**
 * "lathe" attribute: (cos, sin) of the angle around the axis, t up the part,
 * and the part: 0 crown, 1 trunk.
 */
function createTreeArrays() {
  const lathe: number[] = [];
  const index: number[] = [];
  const vertex = (angle: number, t: number, part: number) => {
    lathe.push(Math.cos(angle), Math.sin(angle), t, part);
    return lathe.length / 4 - 1;
  };

  // Crown. Winding is counter-clockwise seen from outside, with the angle
  // running from +x toward +z (a left turn seen from above).
  const bottom = vertex(0, 0, 0);
  const rings = RINGS.map((t, r) =>
    Array.from({ length: SEGMENTS }, (_, s) =>
      vertex(((s + (r % 2) * 0.5) / SEGMENTS) * Math.PI * 2, t, 0)
    )
  );
  const top = vertex(0, 1, 0);
  const next = (s: number) => (s + 1) % SEGMENTS;
  for (let s = 0; s < SEGMENTS; s++) {
    index.push(bottom, rings[0][s], rings[0][next(s)]);
    index.push(top, rings[RINGS.length - 1][next(s)], rings[RINGS.length - 1][s]);
  }
  for (let r = 0; r < RINGS.length - 1; r++) {
    const lower = rings[r];
    const upper = rings[r + 1];
    // Odd rings are turned half a step ahead of even ones.
    const ahead = r % 2 === 0;
    for (let s = 0; s < SEGMENTS; s++) {
      if (ahead) {
        index.push(lower[s], upper[s], lower[next(s)]);
        index.push(lower[next(s)], upper[s], upper[next(s)]);
      } else {
        index.push(lower[s], upper[s], upper[next(s)]);
        index.push(lower[s], upper[next(s)], lower[next(s)]);
      }
    }
  }

  // Trunk: open prism, ground to crown.
  const base = Array.from({ length: TRUNK_SIDES }, (_, s) =>
    vertex((s / TRUNK_SIDES) * Math.PI * 2, 0, 1)
  );
  const head = Array.from({ length: TRUNK_SIDES }, (_, s) =>
    vertex((s / TRUNK_SIDES) * Math.PI * 2, 1, 1)
  );
  for (let s = 0; s < TRUNK_SIDES; s++) {
    const n = (s + 1) % TRUNK_SIDES;
    index.push(base[s], head[s], base[n]);
    index.push(base[n], head[s], head[n]);
  }

  return {
    lathe: new Float32Array(lathe),
    index: new Uint16Array(index),
  };
}

const arrays = createTreeArrays();

/**
 * Fresh attributes over the shared arrays. Each tile's geometry gets its own,
 * since disposing a geometry frees the GPU buffers of every attribute on it.
 */
export function treeAttributes() {
  return {
    lathe: new BufferAttribute(arrays.lathe, 4),
    index: new BufferAttribute(arrays.index, 1),
  };
}
