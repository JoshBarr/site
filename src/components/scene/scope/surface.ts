import { DoubleSide, MeshStandardNodeMaterial } from "three/webgpu";
import {
  abs,
  dFdx,
  dFdy,
  faceDirection,
  float,
  fract,
  fwidth,
  max,
  min,
  mx_fractal_noise_float,
  normalView,
  positionLocal,
  positionView,
  smoothstep,
  vec2,
  vec3,
} from "three/tsl";

// What the satellites are made of, all in greys: their surfaces uneven, with
// fractal noise over each part (in its own metres) shading it lighter and
// darker, rougher and smoother, and bending its normal as a bump map would;
// and panel seams, solar cells' grid or a truss's bays drawn as lines.

interface Surface {
  /** Grey, 0..1, linear. */
  grey: number;
  roughness: number;
  metalness: number;
  /** Noise features a metre, how far they dent it, and how much they mottle it. */
  scale: number;
  bump: number;
  mottle: number;
  /** Lines this many metres apart, this grey (0 none), this many pixels wide. */
  lines?: { every: number; grey: number; width?: number };
  /** Both sides drawn: open shells, like engine bells. */
  open?: boolean;
}

/** 0..1, how near `p` is to a line every `every` m on any axis, antialiased. */
function seams(every: number, width: number) {
  const p = positionLocal.div(every);
  const off = abs(fract(p.add(0.5)).sub(0.5));
  const pixel = fwidth(p).mul(width);
  const near = vec3(off).div(max(pixel, vec3(1e-5)));
  const nearest = min(near.x, min(near.y, near.z));

  // Lines finer than a pixel fade out, rather than shimmer.
  const fine = smoothstep(
    0.6,
    0.15,
    max(pixel.x, max(pixel.y, pixel.z)).div(width)
  );

  return float(1)
    .sub(smoothstep(0.5, 1.5, nearest))
    .mul(fine);
}

/**
 * A grey material, its surface uneven (Mikkelsen's surface gradient, from
 * the noise's screen-space slope), with lines if it's given them.
 */
function surface({
  grey,
  roughness,
  metalness,
  scale,
  bump,
  mottle,
  lines,
  open,
}: Surface) {
  const material = new MeshStandardNodeMaterial({ metalness });

  if (open) material.side = DoubleSide;
  const height = mx_fractal_noise_float(positionLocal.mul(scale), 2, 2, 0.5);
  let shade = float(grey).mul(height.mul(mottle).add(1));

  if (lines) {
    const seam = seams(lines.every, lines.width ?? 1);
    shade = shade.mul(float(1).sub(seam)).add(seam.mul(lines.grey));
  }

  material.colorNode = vec3(shade);
  material.roughnessNode = float(roughness).add(height.mul(0.15)).clamp(0, 1);

  const slope = vec2(dFdx(height), dFdy(height)).mul(bump);
  const x = dFdx(positionView).normalize();
  const y = dFdy(positionView).normalize();
  const r1 = y.cross(normalView);
  const r2 = normalView.cross(x);
  const det = x.dot(r1).mul(faceDirection);
  const gradient = det.sign().mul(slope.x.mul(r1).add(slope.y.mul(r2)));
  material.normalNode = det.abs().mul(normalView).sub(gradient).normalize();

  return material;
}

/** Everything they're made of. */
export function createMaterials() {
  return {
    /** White beta cloth and paint, panelled: the stations' modules. */
    white: surface({
      grey: 0.6,
      roughness: 0.8,
      metalness: 0.05,
      scale: 0.5,
      bump: 0.12,
      mottle: 0.2,
      lines: { every: 1.6, grey: 0.3 },
    }),
    /** Painted metal: rocket stages, buses. */
    body: surface({
      grey: 0.46,
      roughness: 0.55,
      metalness: 0.3,
      scale: 0.5,
      bump: 0.12,
      mottle: 0.3,
      lines: { every: 2, grey: 0.25 },
    }),
    /** Crinkled multi-layer insulation. */
    foil: surface({
      grey: 0.36,
      roughness: 0.3,
      metalness: 0.75,
      scale: 0.9,
      bump: 0.35,
      mottle: 0.45,
    }),
    /** Solar cells: near black, shiny, in a grid. */
    cells: surface({
      grey: 0.07,
      roughness: 0.35,
      metalness: 0.4,
      scale: 0.4,
      bump: 0.05,
      mottle: 0.3,
      lines: { every: 0.9, grey: 0.22 },
    }),
    /** Radiators: bright white panels. */
    radiator: surface({
      grey: 0.75,
      roughness: 0.6,
      metalness: 0.05,
      scale: 0.6,
      bump: 0.08,
      mottle: 0.15,
      lines: { every: 0.6, grey: 0.45 },
    }),
    /** Truss: bays of struts, read as a box with deep lines. */
    truss: surface({
      grey: 0.42,
      roughness: 0.5,
      metalness: 0.5,
      scale: 0.7,
      bump: 0.2,
      mottle: 0.35,
      lines: { every: 1.1, grey: 0.05, width: 2.5 },
    }),
    /** Bare dark metal: engine bells, mechanisms. */
    metal: surface({
      grey: 0.3,
      roughness: 0.4,
      metalness: 0.6,
      scale: 1.5,
      bump: 0.08,
      mottle: 0.25,
      open: true,
    }),
    /** Dark insulation and tiles: foam bands, antenna faces. */
    dark: surface({
      grey: 0.14,
      roughness: 0.8,
      metalness: 0.1,
      scale: 0.8,
      bump: 0.15,
      mottle: 0.3,
      lines: { every: 1.2, grey: 0.06 },
    }),
  };
}

export type Materials = ReturnType<typeof createMaterials>;
