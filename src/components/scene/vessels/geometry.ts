import { BoxGeometry, BufferAttribute, BufferGeometry } from "three/webgpu";

// Unit shapes, scaled per ship. Bow toward -z, deck at y = 1, waterline at 0.

/** Deck plan: transom, parallel sides, then a rounded bow to the stem. */
function deckOutline(segments = 6) {
  const starboard: [number, number][] = [
    [0.5, 0.5],
    [0.5, -0.15],
  ];

  for (let i = 1; i < segments; i++) {
    const angle = (i / segments) * (Math.PI / 2);
    starboard.push([0.5 * Math.cos(angle), -0.15 - 0.35 * Math.sin(angle)]);
  }

  const port = starboard.map(([x, z]): [number, number] => [-x, z]);
  const stern: [number, number] = [0, -0.5];

  return [...starboard, stern, ...port.reverse()];
}

/**
 * Low-poly hull, flat shaded. The `deck` attribute is 1 on the deck so it can
 * be coloured apart from the sides.
 */
export function createHullGeometry() {
  const outline = deckOutline();
  // Narrower and shorter at the keel, below the water.
  const keel = outline.map(([x, z]) => [x * 0.6, z * 0.92] as const);
  const position: number[] = [];
  const deck: number[] = [];

  const triangle = (onDeck: number, ...points: number[][]) => {
    for (const p of points) position.push(...p);
    deck.push(onDeck, onDeck, onDeck);
  };

  outline.forEach(([x, z], i) => {
    const j = (i + 1) % outline.length;
    const [nx, nz] = outline[j];
    const top = [x, 1, z];
    const nextTop = [nx, 1, nz];
    const bottom = [keel[i][0], -0.4, keel[i][1]];
    const nextBottom = [keel[j][0], -0.4, keel[j][1]];
    triangle(0, top, bottom, nextTop);
    triangle(0, nextTop, bottom, nextBottom);
    triangle(1, [0, 1, 0], top, nextTop);
    triangle(0, [0, -0.4, 0], nextBottom, bottom);
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(position), 3)
  );
  geometry.setAttribute("deck", new BufferAttribute(new Float32Array(deck), 1));
  geometry.computeVertexNormals();

  return geometry;
}

/** Unit box standing on the origin, for superstructure and deck cargo. */
export function createBlockGeometry() {
  return new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
}

/**
 * Flat wake trailing aft (+z) from the stern, widening behind. uv.x runs
 * across, uv.y along.
 */
export function createWakeGeometry() {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -2, 0, 1, 2, 0, 1]),
      3
    )
  );
  geometry.setAttribute(
    "uv",
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2)
  );
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  geometry.computeVertexNormals();

  return geometry;
}
