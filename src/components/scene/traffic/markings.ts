import { Color } from "three/webgpu";
import {
  abs,
  clamp,
  float,
  fract,
  fwidth,
  min,
  mix,
  round,
  select,
  smoothstep,
  step,
  vec3,
} from "three/tsl";

// A road's seal and the lines painted on it, drawn by the material from
// where each point of the surface is: shared by the highways and the
// tunnels' floors.

const ROAD = new Color(0x464646);
const LINES = new Color(0xc8c8c8);

/** Lane markings, m: half a line's width, lane width, and the dashes. */
const LINE_HALF = 0.075;
const LANE_M = 3.4;
const DASH = 12;
const DASH_ON = 0.25;

/**
 * The colour of a road at `mark`: across it in lanes from the kerb edge,
 * along it in m, its lanes, and whether traffic comes the other way past
 * the last of them. Lines at whole lanes from the kerb: solid at the
 * edges, dashed between lanes and down the middle of a two-way road.
 */
export function roadColor(mark) {
  const across = mark.x;
  const along = mark.y;
  const lanes = mark.z;
  const k = clamp(round(across), 0, lanes);
  const distance = abs(across.sub(k)).mul(LANE_M);
  const blur = fwidth(across).mul(LANE_M).add(1e-4);

  const cover = smoothstep(
    blur.add(LINE_HALF),
    float(LINE_HALF).sub(blur),
    distance
  ).mul(min(float(LINE_HALF * 2).div(blur), 1));

  const dashed = k
    .greaterThan(0.5)
    .and(k.lessThan(lanes.sub(0.5)).or(mark.w.greaterThan(0.5)));

  const dash = mix(
    step(fract(along.div(DASH)), DASH_ON),
    float(DASH_ON),
    clamp(
      fwidth(along)
        .div(DASH * DASH_ON)
        .sub(0.5),
      0,
      1
    )
  );

  const line = cover.mul(select(dashed, dash, float(1)));

  return mix(
    vec3(ROAD.r, ROAD.g, ROAD.b),
    vec3(LINES.r, LINES.g, LINES.b),
    line
  );
}
