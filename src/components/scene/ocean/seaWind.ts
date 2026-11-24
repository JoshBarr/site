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
  pow,
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
// have had to grow. Together they scale the finer cascades. The longest
// cascade is the open sea's, come from far off: the wind's lee doesn't calm
// it, but the land in its way does (./shelterMap.ts).

/** The field's cells a side, as scripts/wind/build_wind.py writes it. */
const SIZE = 512;

/**
 * Upwind of a point, how far to look for land, m: each sample marks the end
 * of a stretch, so the fetch is the open stretches added up to the first
 * shore. Close enough together that a shore falls part way along a stretch,
 * not at its end: with five, from 150 m to 6 km, mid-harbour's 2.5 km of
 * water to the north-north-west came out as 1 km, the 1.5 km before the
 * sample that found the shore all taken for land. Past GROWN_89 the fetch
 * makes no more difference.
 */
const UPWIND = [100, 200, 350, 550, 800, 1100, 1500, 2000, 2600, 3300, 4000];

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
 * How much of the sea's whitecapped in a wind of so many m/s at 10 m, out
 * where the waves have grown (Monahan & O'Muircheartaigh 1980: 1.5% at
 * 11 m/s, 10% at 20). Under about 4 m/s, none to speak of.
 */
const whitecapped = (speed) => pow(speed, 3.41).mul(3.84e-6).min(0.15);

/** The share of the open sea that's whitecapped, in the wind that's over it. */
export const openWhitecaps = () => whitecapped(openWind.length());

/**
 * How built-up the sea is at world `xz` against the open sea's, for the
 * 89 m and 13 m cascades: (local wind / open wind)² for how hard it blows,
 * times how far the waves have grown over the fetch, times the gusts; and
 * the share of it that's whitecapped, by the wind there and the fetch; and
 * that wind, m/s. For
 * the vertex stage; pass them on to the fragment's in a varying.
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
    const before = reach;
    reach = reach.mul(float(1).sub(texture(land, uvOf(p)).level(float(0)).r));
    // Open as far as the shore, wherever along the stretch that is: half
    // of it, as near as two ends tell.
    stretch = stretch.add(before.add(reach).mul((to - from) / 2));
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

  const speed = open.mul(ratio).mul(gust);

  return {
    built: clamp(grown.mul(ratio.mul(ratio)).mul(gust), LEAST, MOST),
    // Short of its fetch, a sea breaks in smaller and fewer crests.
    whitecaps: whitecapped(speed).mul(grown.x),
    /** The wind here, m/s. */
    speed,
  };
}
