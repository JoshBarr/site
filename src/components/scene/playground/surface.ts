import {
  BufferGeometry,
  CanvasTexture,
  DataTexture,
  Float32BufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardNodeMaterial,
  SRGBColorSpace,
  type Texture,
} from "three/webgpu";
import { luminance, texture, vec3 } from "three/tsl";
import { BANDS, EXTENT, groundAt, PAINT, PATCHES, type Point } from "./layout";

// The playground's ground: its rubber surfaces, paths and garden beds painted
// on a canvas from the layout, laid on a mesh that follows the DEM.

/** Canvas pixels to the metre. */
const PIXELS = 20;

/** Mesh spacing, m: fine enough to follow the DEM's 2 m grid. */
const SPACING = 1;

/** Held this far over the terrain, m, so it never sinks into it. */
const LIFT = 0.05;

/** An outline as a canvas path, rounded through its edges' midpoints. */
function outlinePath(
  outline: Point[],
  sharp: boolean,
  at: (p: Point) => [number, number]
) {
  const path = new Path2D();
  const points = outline.map(at);

  if (sharp) {
    points.forEach(([x, y], i) =>
      i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)
    );
  } else {
    const middle = (a: number[], b: number[]) => [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
    ];

    const start = middle(points[points.length - 1], points[0]);
    path.moveTo(start[0], start[1]);
    points.forEach((point, i) => {
      const [x, y] = middle(point, points[(i + 1) % points.length]);
      path.quadraticCurveTo(point[0], point[1], x, y);
    });
  }

  path.closePath();

  return path;
}

/** Paints the layout onto a canvas, north up; transparent where it's bare. */
function paintSurface() {
  const [west, south, east, north] = EXTENT;
  const canvas = document.createElement("canvas");
  canvas.width = (east - west) * PIXELS;
  canvas.height = (north - south) * PIXELS;
  const context = canvas.getContext("2d");

  if (!context) return null;

  const at = ([e, n]: Point): [number, number] => [
    (e - west) * PIXELS,
    (north - n) * PIXELS,
  ];

  const paths = PATCHES.map((patch) =>
    outlinePath(patch.outline, patch.sharp ?? false, at)
  );

  const inside = (within: number | undefined, draw: () => void) => {
    context.save();

    if (within !== undefined) context.clip(paths[within]);
    draw();
    context.restore();
  };

  PATCHES.forEach((patch, i) =>
    inside(patch.within, () => {
      context.fillStyle = PAINT[patch.paint];
      context.fill(paths[i]);
    })
  );

  context.lineJoin = "round";
  context.lineCap = "round";

  for (const band of BANDS) {
    inside(band.within, () => {
      context.strokeStyle = PAINT[band.paint];
      context.lineWidth = band.width * PIXELS;
      context.beginPath();
      band.line.map(at).forEach(([x, y], i) => {
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    });
  }

  return canvas;
}

/**
 * The surface mesh, in metres from the anchor (x east, z south), its heights
 * the DEM's times `scale`, as the terrain draws them.
 */
export function createSurfaceGeometry(scale: number) {
  const [west, south, east, north] = EXTENT;
  const columns = Math.round((east - west) / SPACING) + 1;
  const rows = Math.round((north - south) / SPACING) + 1;
  const position: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];

  for (let j = 0; j < rows; j++) {
    const n = south + j * SPACING;

    for (let i = 0; i < columns; i++) {
      const e = west + i * SPACING;
      position.push(e, groundAt(e, n) * scale + LIFT, -n);
      uv.push((e - west) / (east - west), (n - south) / (north - south));
    }
  }

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < columns - 1; i++) {
      const a = j * columns + i;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      // Counter-clockwise seen from above: z runs south.
      index.push(a, b, c, b, d, c);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();

  return geometry;
}

function createMap(): Texture {
  const canvas = paintSurface();

  if (!canvas) {
    const empty = new DataTexture(new Uint8Array(4), 1, 1);
    empty.needsUpdate = true;

    return empty;
  }

  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  map.minFilter = LinearMipmapLinearFilter;
  map.magFilter = LinearFilter;
  map.anisotropy = 8;

  return map;
}

/** The surface's material: its paint in greys, as the rest of the scene is. */
export function createSurfaceMaterial() {
  const map = createMap();

  const material = new MeshStandardNodeMaterial({
    roughness: 0.9,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  const paint = texture(map);
  material.colorNode = vec3(luminance(paint.rgb));
  material.opacityNode = paint.a;
  material.alphaTest = 0.5;

  return { material, map };
}
