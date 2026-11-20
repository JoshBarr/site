import { BufferGeometry, Float32BufferAttribute } from "three/webgpu";
import {
  cameraPosition,
  float,
  max,
  min,
  positionGeometry,
  varying,
  vec3,
} from "three/tsl";
import { devicePixelAngle } from "../landmarks/common";

// Wires and cables: far too thin to draw as they are (a conductor's 3 cm
// across, a pixel at a kilometre is a metre), so each is a ribbon turned to
// face the camera, never narrower than a pixel, and fainter instead.

/**
 * A strip of `segments` quads for a ribbon's instances to shape: x is how
 * far along it (0..1), y which edge (-1 or 1).
 */
export function createRibbonGeometry(segments: number) {
  const positions: number[] = [];
  const index: number[] = [];

  for (let i = 0; i <= segments; i++) {
    positions.push(i / segments, -1, 0, i / segments, 1, 0);
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);

  return geometry;
}

/**
 * A ribbon hung from `from` to `to` (world points), dipping `sag` m at its
 * middle, `gauge` m wide: as wide on screen as that or `minPixels` device
 * pixels, whichever's more (but no wider than `maxPixels`, if given), and
 * `fringed`, with half a pixel more either side for its edges to fade out
 * over. Returns where each vertex goes, and for its fragments:
 *
 *   coverage  how much of its drawn width the ribbon really fills, 0..1
 *   edge      1 across the ribbon, falling to 0 over its fringes
 *   normal    world space, square to the ribbon and toward the camera
 *
 * Fainter than `faintest`, it's not drawn at all.
 */
export function hangRibbon(
  from,
  to,
  sag,
  gauge,
  {
    minPixels = 1,
    maxPixels,
    faintest = 0,
    fringed = true,
  }: {
    minPixels?: number;
    maxPixels?: number;
    faintest?: number;
    fringed?: boolean;
  } = {}
) {
  const t = positionGeometry.x;
  const side = positionGeometry.y;
  const chord = to.sub(from);

  // A parabola: near enough a catenary at these sags.
  const dip = sag.mul(4);

  const centre = from
    .add(chord.mul(t))
    .sub(vec3(0, dip.mul(t).mul(float(1).sub(t)), 0));

  const tangent = chord
    .sub(vec3(0, dip.mul(float(1).sub(t.mul(2))), 0))
    .normalize();

  const toCamera = cameraPosition.sub(centre);
  const pixel = toCamera.length().mul(devicePixelAngle);
  const wide = max(gauge, pixel.mul(minPixels));
  const drawn = maxPixels ? min(wide, pixel.mul(maxPixels)) : wide;
  const coverage = gauge.div(wide);
  const half = drawn.mul(0.5);

  const reach = coverage
    .lessThan(faintest)
    .select(float(0), fringed ? half.add(pixel.mul(0.5)) : half);

  const right = tangent.cross(toCamera).normalize();
  // Passed down: per vertex, and worked out again per pixel otherwise.
  const across: any = varying(side.mul(reach));
  const fringe: any = varying(pixel);
  const core: any = varying(half);
  const filled: any = varying(coverage);

  return {
    position: centre.add(right.mul(side).mul(reach)),
    coverage: filled,
    edge: core.sub(across.abs()).div(fringe).add(0.5).clamp(0, 1),
    normal: varying(
      toCamera.sub(tangent.mul(toCamera.dot(tangent))).normalize()
    ),
  };
}
