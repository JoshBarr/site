import {
  Data3DTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  Vector2,
  Vector4,
} from "three/webgpu";
import {
  If,
  clamp,
  float,
  max,
  mix,
  smoothstep,
  texture3D,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { coverageMap, LOW_ANGLE, MID_ANGLE } from "./coverage";

// What the cloud layers are made of, shared by the cloud march and the
// shadows the clouds cast on the scene.

/**
 * A cloud layer: shape is (base, top, coverage, density) in metres and 0..1;
 * offset is a drift in metres that the wind advances each frame. For cirrus,
 * shape is (altitude, coverage, -, -).
 */
export function createLayerUniforms() {
  return {
    shape: uniform(new Vector4(1000, 1600, 0, 1)),
    offset: uniform(new Vector2()),
  };
}

export type CloudLayerUniforms = ReturnType<typeof createLayerUniforms>;

/** The sky's layers. Clouds keeps them current with the weather and wind. */
export const cloudLayers = {
  low: createLayerUniforms(),
  mid: createLayerUniforms(),
  cirrus: createLayerUniforms(),
};

export const NOISE_SIZE = 64;
export const WEATHER_SIZE = 256;

function createNoise() {
  const shape = new Data3DTexture(
    new Uint8Array(NOISE_SIZE ** 3 * 4),
    NOISE_SIZE,
    NOISE_SIZE,
    NOISE_SIZE
  );
  shape.format = RGBAFormat;
  shape.wrapS = shape.wrapT = shape.wrapR = RepeatWrapping;
  shape.minFilter = shape.magFilter = LinearFilter;
  shape.needsUpdate = true;

  const weather = new DataTexture(
    new Uint8Array(WEATHER_SIZE ** 2 * 4),
    WEATHER_SIZE,
    WEATHER_SIZE,
    RGBAFormat
  );
  weather.wrapS = weather.wrapT = RepeatWrapping;
  weather.magFilter = LinearFilter;
  weather.minFilter = LinearMipmapLinearFilter;
  weather.generateMipmaps = true;
  weather.needsUpdate = true;

  return { shape, weather };
}

/**
 * The clouds' noise textures. Blank, so no cloud anywhere, until Clouds
 * fills them from noiseWorker; they keep their identity so materials built
 * before then pick the noise up.
 */
export const cloudNoise = createNoise();

/** Extinction per metre at full density. */
export const EXTINCTION = 0.035;
/** Cloud body noise repeats every this many metres. */
const SHAPE_SCALE = 3200;
const DETAIL_SCALE = 520;

export const remap = (v, a, b, c, d) =>
  c.add(v.sub(a).div(b.sub(a)).mul(d.sub(c)));
export const saturate = (v) => clamp(v, 0, 1);

export interface LayerStyle {
  /** Where the top starts to taper, as a fraction of the layer's depth. */
  flatTop: number;
  /** Turn of the coverage map, radians. */
  angle: number;
  /** Size of the cloud bodies, m. */
  scale: number;
}

/** Low cloud is flatter (stratocumulus). */
export const LOW_STYLE: LayerStyle = {
  flatTop: 0.75,
  angle: LOW_ANGLE,
  scale: SHAPE_SCALE,
};
export const MID_STYLE: LayerStyle = {
  flatTop: 0.5,
  angle: MID_ANGLE,
  scale: SHAPE_SCALE * 1.37,
};

/**
 * Density of one layer at p. Checks the cheap 2D coverage first and only
 * reads the 3D noise where there can be cloud. `cheap` skips the detail
 * erosion, for samples toward the sun; `erosion` then takes off that much
 * evenly instead (the detail averages 0.5), for the cloud's outline from
 * afar. `lid` (0..1) closes the layer into an unbroken deck.
 */
export function layerDensity(
  p,
  layer: CloudLayerUniforms,
  { flatTop, angle, scale }: LayerStyle,
  {
    lid = null,
    cheap = false,
    erosion = 0,
  }: { lid?: any; cheap?: boolean; erosion?: number } = {}
) {
  const { shape, offset } = layer;
  const { shape: shapeNoise, weather } = cloudNoise;
  const density = float(0).toVar();
  const h = p.y.sub(shape.x).div(shape.y.sub(shape.x));

  If(h.greaterThan(0).and(h.lessThan(1)), () => {
    // Rounded bases, tapering tops.
    const profile = smoothstep(0, 0.12, h).mul(smoothstep(1, flatTop, h));

    const { rotated, broad, fine, map } = coverageMap(
      weather,
      p.xz,
      offset,
      angle
    );

    // Coverage picks the regions that hold cloud, then fills them: low
    // cover is a few large clouds, not a scatter of small ones. Regions
    // narrow with height for rounded tops rather than columns. The soft
    // edge would still let the map's peaks through at no cover, so the last
    // few percent fade out to clear sky.
    const coverage = shape.z;
    const region = smoothstep(
      float(1).sub(coverage).sub(0.12),
      float(1).sub(coverage).add(0.12),
      map
    ).mul(saturate(coverage.mul(20)));
    const cloudiness = region
      .mul(mix(0.55, 0.9, coverage))
      .mul(float(1).sub(h.mul(0.45)));
    const closing = lid ?? float(0);

    If(cloudiness.greaterThan(0.01).or(closing.greaterThan(0.01)), () => {
      // Warp the bodies by the coverage map too, breaking up the cells.
      const drifted = rotated.add(
        vec2(broad.g, fine.g)
          .sub(0.5)
          .mul(scale * 0.6)
      );
      const body = texture3D(
        shapeNoise,
        vec3(drifted.x, p.y, drifted.y).div(scale)
      ).r;
      const base = saturate(
        remap(
          body.mul(profile),
          float(1).sub(cloudiness),
          float(1),
          float(0),
          float(1)
        )
      );

      // Erode more at the bottom of the cloud for wispy bases.
      const erode = (amount) =>
        saturate(
          remap(
            base,
            amount.mul(mix(0.6, 0.35, saturate(h))),
            float(1),
            float(0),
            float(1)
          )
        );
      let value: any = base;
      if (!cheap) {
        const detail = texture3D(
          shapeNoise,
          vec3(drifted.x, p.y, drifted.y).div(DETAIL_SCALE)
        );
        value = erode(
          detail.g.mul(0.625).add(detail.b.mul(0.25)).add(detail.a.mul(0.125))
        );
      } else if (erosion > 0) {
        value = erode(float(erosion));
      }
      // Overcast closes the low layer into an unbroken stratus deck.
      if (lid) {
        value = max(value, closing.mul(profile).mul(mix(0.5, 0.8, base)));
      }
      density.assign(value.mul(shape.w));
    });
  });

  return density;
}
