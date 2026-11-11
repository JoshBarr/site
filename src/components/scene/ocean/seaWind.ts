import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  type PixelFormat,
} from "three/webgpu";
import {
  clamp,
  float,
  max,
  mx_noise_float,
  sqrt,
  texture,
  time,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { FIELD_SCALE, loadWindField } from "../wind/field";

// The sea's wind, place by place. The spectrum is one sea for one wind, but
// Wellington's harbour isn't: lee shores lie glassy while gusts streak the
// open water. The land's wind field (../wind/field.ts) slows and turns the
// wind; how much open water lies upwind (the fetch) is how far the waves
// have had to grow. Together they scale the finer cascades. The swell came
// from far off and passes the lee unchanged.

/** The field's cells a side, as scripts/wind/build_wind.py writes it. */
const SIZE = 512;

/**
 * Upwind of a point, how far to look for land, m: each sample marks the end
 * of a stretch, so the fetch is the open stretches added up to the first
 * shore.
 */
const UPWIND = [150, 400, 1000, 2500, 6000];

/** Fetch the finer cascades need to be fully grown, m. */
const GROWN_89 = 4000;
const GROWN_13 = 400;

/** Gust fronts: this big, m, this much stronger or weaker, moving downwind. */
const GUST_SIZE = 900;
const GUSTINESS = 0.3;

/** How fast the gust pattern changes as it goes, per s. */
const GUST_CHANGE = 0.02;

/** No stretch of water lies quite still, nor gets more than this. */
const LEAST = 0.08;
const MOST = 1.4;

function byteTexture(data: Uint8Array, format: PixelFormat) {
  const map = new DataTexture(data, SIZE, SIZE, format, UnsignedByteType);

  map.magFilter = map.minFilter = LinearFilter;
  map.wrapS = map.wrapT = ClampToEdgeWrapping;
  map.generateMipmaps = false;
  map.needsUpdate = true;

  return map;
}

// Until the field's in: the open-sea wind everywhere, and no land.
const flowData = new Uint8Array(SIZE * SIZE * 4);
const still = 128 + FIELD_SCALE;

for (let i = 0; i < SIZE * SIZE; i++) {
  flowData.set([still, 128, 128, still], i * 4);
}

const flow = byteTexture(flowData, RGBAFormat);
const landData = new Uint8Array(SIZE * SIZE);
const land = byteTexture(landData, RedFormat);

/** The wind out at sea, m/s, x east and z south. */
export const openWind = uniform(new Vector2(7, 0));

let loading: Promise<void> | null = null;

/** Fills the maps from the field, once; the wind trails load it too. */
export function loadSeaWind() {
  loading ??= loadWindField().then((field) => {
    if (field.size !== SIZE) {
      console.warn(`[sea wind] field is ${field.size}², not ${SIZE}²`);

      return;
    }

    flowData.set(field.data);
    landData.set(field.land);
    flow.needsUpdate = land.needsUpdate = true;
  });

  return loading;
}

/**
 * How built-up the sea is at world `xz` against the open sea's, for the
 * 89 m and 13 m cascades: (local wind / open wind)² for how hard it blows,
 * times how far the waves have grown over the fetch, times the gusts. For
 * the vertex stage; pass it on to the fragment's in a varying.
 */
export function seaWindiness(xz, rootSize: number) {
  const half = rootSize / 2;
  const uvOf = (p) => p.add(half).div(rootSize);

  const c = texture(flow, uvOf(xz))
    .level(float(0))
    .sub(128 / 255)
    .mul(255 / FIELD_SCALE);

  const local = c.xy.mul(openWind.x).add(c.zw.mul(openWind.y));
  const open = max(openWind.length(), 0.5);
  const ratio = local.length().div(open);

  // Open water upwind, to the first shore.
  const upwind = openWind.div(open).negate();
  let reach: any = float(1);
  let stretch: any = float(0);
  let from = 0;

  for (const to of UPWIND) {
    const p = xz.add(upwind.mul(to));
    reach = reach.mul(float(1).sub(texture(land, uvOf(p)).level(float(0)).r));
    stretch = stretch.add(reach.mul(to - from));
    from = to;
  }

  // Waves grow about as the root of their fetch.
  const grown = vec2(
    sqrt(stretch.div(GROWN_89).saturate()),
    sqrt(stretch.div(GROWN_13).saturate())
  );

  const drift = openWind.mul(time);

  const gust = mx_noise_float(
    vec3(xz.sub(drift).div(GUST_SIZE), time.mul(GUST_CHANGE))
  )
    .mul(GUSTINESS * 2)
    .add(1);

  return clamp(grown.mul(ratio.mul(ratio)).mul(gust), LEAST, MOST);
}
