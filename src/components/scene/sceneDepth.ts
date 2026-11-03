import {
  FloatType,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  QuadMesh,
  RenderTarget,
  Texture,
  Vector2,
  WebGPURenderer,
} from "three/webgpu";
import {
  Fn,
  int,
  perspectiveDepthToViewZ,
  screenCoordinate,
  texture,
  uniform,
  uniformArray,
  vec4,
} from "three/tsl";

// The depth of the scene as last drawn, read back at a few points: whether
// something's in front of what's there, say.

/** Points read at once, at most. */
export const DEPTH_POINTS = 32;

let depth: Texture | null = null;

/** The depth texture the frame is drawn with, or null when there isn't one. */
export function setSceneDepth(texture: Texture | null) {
  depth = texture;
}

function createReader() {
  // Set in place: the uniform reads them each time it's drawn.
  const uvs = Array.from({ length: DEPTH_POINTS }, () => new Vector2());
  const at = uniformArray(uvs, "vec2");

  const near = uniform(1);
  const far = uniform(1);
  const sampled = texture(new Texture());
  const material = new MeshBasicNodeMaterial();

  // A pixel for each point: how far in front of the camera the scene is
  // there, along its view axis.
  material.fragmentNode = Fn(() => {
    const uv = at.element(int(screenCoordinate.x));
    const z = perspectiveDepthToViewZ(sampled.sample(uv).r, near, far);

    return vec4(z.negate(), 0, 0, 1);
  })();

  const target = new RenderTarget(DEPTH_POINTS, 1, {
    type: FloatType,
    depthBuffer: false,
  });

  return { uvs, near, far, sampled, quad: new QuadMesh(material), target };
}

let reader: ReturnType<typeof createReader> | null = null;

/**
 * How far in front of `camera` (along its view axis, m) the scene was drawn
 * at each of `points`, -1..1 across and up the view, as three has it; null
 * with no depth to read. At most DEPTH_POINTS.
 */
export async function sceneDepthsAt(
  renderer: WebGPURenderer,
  camera: PerspectiveCamera,
  points: { x: number; y: number }[]
): Promise<Float32Array | null> {
  if (!depth || !points.length) return null;
  reader ??= createReader();
  const { uvs, near, far, sampled, quad, target } = reader;
  const n = Math.min(points.length, DEPTH_POINTS);

  for (let i = 0; i < n; i++) {
    // Textures run down from the top, in three's node materials.
    const { x, y } = points[i];
    uvs[i].set(x * 0.5 + 0.5, 0.5 - y * 0.5);
  }

  near.value = camera.near;
  far.value = camera.far;
  sampled.value = depth;

  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  quad.render(renderer);
  renderer.setRenderTarget(previous);

  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, n, 1);
  const depths = new Float32Array(n);

  for (let i = 0; i < n; i++) depths[i] = Number(pixels[i * 4]);

  return depths;
}
