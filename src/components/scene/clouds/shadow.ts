import {
  HalfFloatType,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  Vector2,
  WebGPURenderer,
} from "three/webgpu";
import {
  Fn,
  abs,
  exp,
  float,
  max,
  mix,
  normalize,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  CloudLayerUniforms,
  cloudLayers,
  EXTINCTION,
  layerDensity,
  LayerStyle,
  LOW_STYLE,
  MID_STYLE,
} from "./density";
import { rainDeck } from "./rainField";

// The clouds' shadows, worked out once a frame into a small map over the
// country around the camera, rather than for every pixel lit. Each texel holds
// the sun let through along its ray; a surface finds its ray by following it
// up to the map's plane.

const MAP_SIZE = 256;

/** Width of ground the map covers, m. Beyond it, haze hides the shadows. */
const EXTENT = 40000;
const TEXEL = EXTENT / MAP_SIZE;

/**
 * Seconds between redraws. Drawing the map is a pass of its own, which
 * costs more than its few texels; the clouds drift a few metres between
 * redraws, under shadows blurred over hundreds.
 */
const REFRESH = 0.2;

/**
 * Rays toward the sun, spread around each texel. Averaging their depth
 * through the cloud blurs it, so the shadow keeps a dark core and fades out
 * past the cloud's edge.
 */
const TAPS = 4;

/** How far the taps spread, as a fraction of a layer's cloud size. */
const SPREAD = 0.06;

/**
 * Samples along each tap's ray through a layer, staggered between taps so
 * together they cover the depth of the layer.
 */
const LOW_SAMPLES = 4;
const MID_SAMPLES = 3;

/**
 * Less than the clouds' own erosion (0.5 on average), so a shadow spreads a
 * little wider than its cloud.
 */
const EROSION = 0.3;

/**
 * A map of the sun let through the clouds (1 clear, 0 shadowed), toward
 * `toSun`. `sample` reads it at a world position; `update` redraws it around
 * a point every so often, which Clouds calls each frame as they drift.
 * Leaves out the overcast lid (see cloudShadow in environment).
 */
export function createCloudShadowMap(toSun) {
  const target = new RenderTarget(MAP_SIZE, MAP_SIZE, {
    type: HalfFloatType,
    depthBuffer: false,
  });

  const centre = uniform(new Vector2());
  // Keeps the slant through a layer finite as the sun sets; by then its
  // light has faded out anyway.
  const ray = normalize(vec3(toSun.x, max(toSun.y, 0.05), toSun.z));
  // The map lies halfway up the low layer.
  const { low, mid } = cloudLayers;
  const plane = low.shape.x.add(low.shape.y).mul(0.5);
  // Across the ground per metre climbed along the ray.
  const slope = ray.xz.div(ray.y);

  /** Depth through a layer along the ray crossing the plane at c. */
  const through = (
    c,
    layer: CloudLayerUniforms,
    style: LayerStyle,
    samples: number
  ) => {
    const base = layer.shape.x;
    const dy = layer.shape.y.sub(base).div(samples);
    const spread = style.scale * SPREAD;
    const depth = float(0).toVar();

    for (let tap = 0; tap < TAPS; tap++) {
      const angle = ((tap + 0.5) / TAPS) * Math.PI * 2;
      const stagger = (tap + 0.5) / TAPS;

      const origin = c.add(
        vec2(Math.cos(angle) * spread, Math.sin(angle) * spread)
      );

      for (let i = 0; i < samples; i++) {
        const y = base.add(dy.mul(i + stagger));
        const xz = origin.add(slope.mul(y.sub(plane)));
        const q = vec3(xz.x, y, xz.y);
        depth.addAssign(
          layerDensity(q, layer, style, {
            cheap: true,
            erosion: EROSION,
            // The deck over measured rain shades what's under it.
            lid: layer === low ? () => rainDeck(xz) : null,
          })
        );
      }
    }

    // Each sample stands for dy of height, dy / ray.y of ray.
    return exp(depth.mul(dy.div(ray.y)).div(TAPS).mul(-EXTINCTION));
  };

  // Low and mid layers apart, so ground up in the low cloud can be spared
  // its shadow.
  const material = new NodeMaterial();
  material.fragmentNode = Fn(() => {
    const c = centre.add(uv().sub(0.5).mul(EXTENT));

    return vec4(
      through(c, low, LOW_STYLE, LOW_SAMPLES),
      through(c, mid, MID_STYLE, MID_SAMPLES),
      0,
      1
    );
  })();
  const quad = new QuadMesh(material);
  let sinceDrawn = Infinity;

  return {
    sample(p) {
      const crossing = p.xz.add(slope.mul(plane.sub(p.y)));
      const at = crossing.sub(centre).div(EXTENT).add(0.5);
      const map = texture(target.texture, at);
      // Ground above the low cloud's base is partly or wholly over it.
      const under = mix(1, map.r, smoothstep(low.shape.y, low.shape.x, p.y));
      const edge = max(abs(at.x.sub(0.5)), abs(at.y.sub(0.5)));

      return mix(under.mul(map.g), 1, smoothstep(0.4, 0.5, edge));
    },

    update(renderer: WebGPURenderer, x: number, z: number, delta: number) {
      sinceDrawn += delta;

      if (sinceDrawn < REFRESH) return;
      sinceDrawn = 0;
      // On whole texels, so the shadows don't crawl as the camera moves.
      centre.value.set(
        Math.round(x / TEXEL) * TEXEL,
        Math.round(z / TEXEL) * TEXEL
      );
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      quad.render(renderer);
      renderer.setRenderTarget(previous);
    },
  };
}
