import { clamp, cross, exp, float, mix, smoothstep, uv } from "three/tsl";
import type { Node } from "three/webgpu";

// Lamps at night, drawn as additive sprites: bigger than life, at least a
// few pixels across, so they still read from kilometres off.

/** Of a sprite's width, what its core covers: where neighbours stack up. */
const CORE = 0.5;

/** Beyond this, metres, lamps dim with distance as well. */
const NEAR = 4000;

/** A hot core in a soft halo of `halo` its brightness, gone by the edge. */
export function lampGlow(halo: number) {
  const r = uv().sub(0.5).length().mul(2);

  return exp(r.mul(r).mul(-40))
    .add(exp(r.mul(-4.5)).mul(halo))
    .mul(float(1).sub(smoothstep(0.85, 1, r)));
}

/** Far off, they're points, not lamps: dimming, 0..1, at `distance`. */
export function distantDim(distance: Node<"float">) {
  return clamp(float(NEAR).div(distance), 0, 1);
}

/**
 * Drawn bigger than life, a row's lamps pile up on screen, more so seen end
 * on: each gives its share, so the row reads as one lamp's worth per core's
 * width, not a bar of glare. `row` is the row's direction, unit or zero for
 * lamps in no straight line (taken as square on); `spacing` metres between
 * lamps; `size` the sprite's, metres; and none goes under `least`.
 */
interface Row {
  toCamera: Node<"vec3">;
  distance: Node<"float">;
  row: Node<"vec3">;
  spacing: Node<"float">;
  size: Node<"float">;
  least: Node<"float"> | number;
}

export function rowShare({
  toCamera,
  distance,
  row,
  spacing,
  size,
  least,
}: Row) {
  const square = mix(
    float(1),
    cross(toCamera.div(distance), row).length(),
    row.length()
  );

  return clamp(spacing.mul(square).div(size.mul(CORE)), least, 1);
}
