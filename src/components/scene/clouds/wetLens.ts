import {
  AddEquation,
  Camera,
  Color,
  CustomBlending,
  DoubleSide,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  Quaternion,
  RenderTarget,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import {
  Fn,
  If,
  atan,
  clamp,
  dot,
  float,
  fwidth,
  instancedBufferAttribute,
  max,
  mix,
  normalize,
  positionGeometry,
  pow,
  screenUV,
  select,
  sin,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { switchedOff } from "../stats";
import {
  CAPACITY,
  createLensWater,
  type DrawnDrop,
  type DrawnThread,
  THREADS,
} from "./lensWater";
import type { RainUniforms } from "./rain";

// Water on the glass in front of the lens, when it rains on the camera: the
// drops of ./lensWater.ts, each drawn into a field as a soft blob, the
// blobs summed, so drops near each other swell into one shape with a neck
// between them, as metaballs do. Where the field's over a level is water;
// how steeply it climbs bends what's behind, upside down through the
// middle of each drop as a lens of water does, softened, darker at the rim
// and catching the light from the sky above.

/** A drop's blob reaches this many of its radii out... */
const REACH = 1.8;

/** ...and the water's edge is where the blobs sum to a lone drop's at one radius. */
const LEVEL = Math.pow(1 - 1 / (REACH * REACH), 3);

/** The field's size, of the frame's in CSS pixels. */
const FIELD_SCALE = 0.5;

/**
 * How far off a drop's face bends the view, in screen heights, by how
 * steeply it slopes: by its slope, not its size, so even a small drop shows
 * a wide view, upside down, as a lens of water does.
 */
const BEND = 0.3;

/** A running drop's tail narrows by up to this share of its head's width. */
const TAPER = 0.45;

/** How steeply a drop's face seems to rise, by how steeply the field does. */
const STEEP = 0.35;

/** Spread of the samples softening what a drop shows, of its radius, and least, of the screen. */
const BLUR = 0.25;
const LEAST_BLUR = 0.0015;

/** How dark a drop's rim, where it bends in light from off the frame. */
const RIM = 0.4;

/** The sky's light caught on each drop. */
const GLINT = 0.5;

/**
 * Rain lands on glass facing across it this much as on glass facing into
 * it, whatever the slant: splashes and spray. Less facing down.
 */
const SPRAY = 0.3;

/**
 * The camera's own speed counts as wind across the glass up to about this,
 * m/s: it flies kilometres a second, which would wipe the glass at a touch.
 */
const RUSH = 8;

/** Faster than this, m/s, the camera jumped: no wind from that. */
const JUMP = 3000;

/** 1 with water on the glass, 0 dry: the composite skips dry glass. */
const wet = uniform(0);

/** The frame's width over its height. */
const aspect = uniform(1);

function createField() {
  const target = new RenderTarget(1, 1, {
    type: HalfFloatType,
    depthBuffer: false,
  });

  // Where each drop is and how big (x, y, radius, seed), and the way it runs
  // with how far its tail sweeps behind (dx, dy, stretch).
  const places = new Float32Array(CAPACITY * 4);
  const sweeps = new Float32Array(CAPACITY * 4);
  const place = new InstancedBufferAttribute(places, 4);
  const sweep = new InstancedBufferAttribute(sweeps, 4);
  const at = instancedBufferAttribute<"vec4">(place, "vec4");
  const runs = instancedBufferAttribute<"vec4">(sweep, "vec4");

  const quad = new PlaneGeometry(2, 2);
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.getAttribute("position"));
  geometry.instanceCount = 0;

  // Either way round: the quads are turned to the drop's way.
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });

  // Summed as they are, signs and all.
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneFactor;
  material.blendEquationAlpha = AddEquation;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneFactor;
  material.fog = false;

  const radius = at.z;
  const stretch = runs.z;

  // A square around the drop and its tail, in screen heights, y down.
  const offset = positionGeometry.xy
    .mul(radius.mul(REACH).mul(stretch.add(1)))
    .mul(vec2(1, -1));

  const centre = at.xy.add(offset);

  material.vertexNode = vec4(
    centre.x.div(aspect).mul(2).sub(1),
    float(1).sub(centre.y.mul(2)),
    0,
    1
  );

  // In the drop's radii.
  const v = varying(offset.div(max(radius, 1e-6)), "vLensDrop");

  material.fragmentNode = Fn(() => {
    const ahead = runs.xy;
    const sideways = vec2(ahead.y.negate(), ahead.x);
    const along = dot(v, ahead);
    const side = dot(v, sideways);
    // Swept out behind as it runs: a round head and a tail, narrowing
    // toward its end, the head the heaviest of it.
    const sweepOut = select(along.lessThan(0), stretch.add(1), float(1));
    const a = along.div(sweepOut);
    const behind = clamp(a.negate().div(REACH), 0, 1).mul(stretch.div(1.5));
    const narrow = float(1).sub(behind.mul(TAPER));
    const across = side.div(narrow);

    const q = a
      .mul(a)
      .add(across.mul(across))
      .div(REACH * REACH);

    // Out of round at the edge, a little: the glass doesn't hold water evenly.
    const turn = atan(across, a);
    const seed = at.w.mul(6.283);

    const round = sin(turn.mul(3).add(seed))
      .mul(0.07)
      .add(sin(turn.mul(5).add(seed.mul(2.7))).mul(0.05))
      .add(1);

    const blob = pow(max(float(1).sub(q.div(round.mul(round))), 0), 3);

    // Its slope as a round blob's (the edge's ripple left out), in screen
    // heights per screen height times its radius², so the same in any size.
    const fall = pow(max(float(1).sub(q), 0), 2).mul(-6 / (REACH * REACH));

    const slope = ahead
      .mul(a.div(sweepOut))
      .add(sideways.mul(across.div(narrow)))
      .mul(fall)
      .mul(radius);

    return vec4(blob, slope, blob.mul(radius));
  })();

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new Scene();
  const threads = createThreads(quad, material);
  scene.add(mesh, threads.mesh);

  return {
    target,
    place,
    sweep,
    places,
    sweeps,
    geometry,
    threads,
    scene,
    camera: new OrthographicCamera(),
  };
}

/**
 * The threads running drops leave (see ./lensWater.ts), into the same field
 * as the drops: each piece a line of water, round across and cut square at
 * its ends, so the pieces meet without a bulge where they join. Blended
 * as `like` blends.
 */
function createThreads(quad: PlaneGeometry, like: MeshBasicNodeMaterial) {
  // Its ends (x0, y0 the older, x1, y1) and its radius.
  const endData = new Float32Array(THREADS * 4);
  const radiusData = new Float32Array(THREADS);
  const ends = new InstancedBufferAttribute(endData, 4);
  const radii = new InstancedBufferAttribute(radiusData, 1);
  const end = instancedBufferAttribute<"vec4">(ends, "vec4");
  const radius = instancedBufferAttribute<"float">(radii, "float");

  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.getAttribute("position"));
  geometry.instanceCount = 0;

  // Either way round: the quads are turned to the drop's way.
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });

  material.blending = like.blending;
  material.blendEquation = like.blendEquation;
  material.blendSrc = like.blendSrc;
  material.blendDst = like.blendDst;
  material.blendEquationAlpha = like.blendEquationAlpha;
  material.blendSrcAlpha = like.blendSrcAlpha;
  material.blendDstAlpha = like.blendDstAlpha;
  material.fog = false;

  const along = end.zw.sub(end.xy);
  const length = along.length();
  const ahead = along.div(max(length, 1e-6));
  const sideways = vec2(ahead.y.negate(), ahead.x);
  const reach = radius.mul(REACH);

  // A box around the piece, in screen heights, y down.
  const offset = ahead
    .mul(positionGeometry.x.mul(length.mul(0.5)))
    .add(sideways.mul(positionGeometry.y.mul(reach)));

  const centre = end.xy.add(end.zw).mul(0.5).add(offset);

  material.vertexNode = vec4(
    centre.x.div(aspect).mul(2).sub(1),
    float(1).sub(centre.y.mul(2)),
    0,
    1
  );

  const v = varying(offset, "vLensThread");

  material.fragmentNode = Fn(() => {
    // Straight across from the line: along it, the next piece carries on.
    const out = sideways.mul(dot(v, sideways));
    const q = dot(out, out).div(max(reach.mul(reach), 1e-10));
    const blob = pow(max(float(1).sub(q), 0), 3);
    const fall = pow(max(float(1).sub(q), 0), 2).mul(-6 / (REACH * REACH));

    return vec4(blob, out.mul(fall), blob.mul(radius));
  })();

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;

  return { mesh, geometry, ends, radii, endData, radiusData };
}

let field: ReturnType<typeof createField> | null = null;
const water = createLensWater();

const drop: DrawnDrop = {
  x: 0,
  y: 0,
  radius: 0,
  seed: 0,
  dx: 0,
  dy: 1,
  stretch: 0,
};

const piece: DrawnThread = { x0: 0, y0: 0, x1: 0, y1: 0, radius: 0 };

const getField = () => (field ??= createField());

/**
 * The finished `frame`, seen through the water on the lens. `view` gives
 * the frame's colour at a screen uv, near enough, for what the drops bend
 * into view.
 */
export function wetLens(frame, view: (uv) => any) {
  if (switchedOff("wetlens")) return frame;

  const { target } = getField();

  return Fn(() => {
    const color = frame.rgb.toVar();

    If(wet.greaterThan(0), () => {
      const sum = texture(target.texture, screenUV);
      const f = sum.r;
      // A pixel's worth of the field, for a smooth edge at any size.
      const pixel = max(fwidth(f), 1e-4);

      If(f.greaterThan(float(LEVEL).sub(pixel)), () => {
        const cover = clamp(f.sub(LEVEL).div(pixel).add(0.5), 0, 1);
        const slope = sum.gb;
        const radius = sum.a.div(max(f, 1e-4));
        const depth = clamp(f.sub(LEVEL).div(1 - LEVEL), 0, 1);

        // Through the drop: across its middle, upside down, a little soft.
        const steepness = slope.div(max(radius, 1e-5));
        const bend = steepness.mul(BEND);
        const uv = screenUV.add(vec2(bend.x.div(aspect), bend.y));
        const spread = radius.mul(BLUR).add(LEAST_BLUR);
        const sx = vec2(spread.div(aspect), 0);
        const sy = vec2(0, spread);
        const clamped = (at) => clamp(at, 0, 1);

        const seen = view(clamped(uv.add(sx)))
          .add(view(clamped(uv.sub(sx))))
          .add(view(clamped(uv.add(sy))))
          .add(view(clamped(uv.sub(sy))))
          .mul(0.25);

        // Dark at the rim, where it bends light in from off the frame.
        const rim = pow(float(1).sub(depth), 2).mul(RIM);

        // The sky's light caught on its face, from above and a little left.
        const face = normalize(vec3(steepness.mul(-STEEP), 1));

        const toward = normalize(vec3(-0.25, -0.75, 1));
        const sky = view(vec2(0.5, 0.12));
        const brightness = dot(sky, vec3(0.2126, 0.7152, 0.0722));

        const glint = pow(max(dot(face, toward), 0), 80)
          .mul(GLINT)
          .mul(max(brightness, 0.04));

        const through = seen.mul(float(1).sub(rim)).add(glint);

        color.assign(mix(color, through, cover));
      });
    });

    return vec4(color, 1);
  })();
}

const size = new Vector2();
const turned = new Quaternion();
const down = new Vector3();
const air = new Vector3();
const rainAt = new Vector3();
const rush = new Vector3();
const lastAt = new Vector3();
let placed = false;
const clearColor = new Color();

/**
 * Moves the water on the lens on by `delta` seconds and redraws its field,
 * with the camera as it is and `rainfall` (as lensRain has it) falling on
 * it through `rain`'s wind. `held` keeps it still (?freeze).
 */
export function updateWetLens(
  renderer: WebGPURenderer,
  camera: Camera,
  rainfall: number,
  rain: RainUniforms,
  delta: number,
  held = false
) {
  const f = getField();

  renderer.getSize(size);
  const width = Math.max(Math.round(size.x * FIELD_SCALE), 1);
  const height = Math.max(Math.round(size.y * FIELD_SCALE), 1);

  if (f.target.width !== width || f.target.height !== height) {
    f.target.setSize(width, height);
  }

  aspect.value = size.x / Math.max(size.y, 1);

  // The world turned into the camera's axes.
  camera.getWorldQuaternion(turned).invert();
  down.set(0, -1, 0).applyQuaternion(turned);

  // The camera's own speed, as wind, eased off.
  if (placed && delta > 0) {
    rush.copy(camera.position).sub(lastAt).divideScalar(delta);
    const speed = rush.length();

    if (speed > JUMP || speed < 1e-3) rush.set(0, 0, 0);
    else rush.multiplyScalar((RUSH * Math.tanh(speed / RUSH)) / speed);
  } else {
    rush.set(0, 0, 0);
  }

  lastAt.copy(camera.position);
  placed = true;

  if (switchedOff("lensrush")) rush.set(0, 0, 0);

  const [wx, wz] = [rain.wind.value.x, rain.wind.value.y];
  air.set(wx, 0, wz).sub(rush).applyQuaternion(turned);
  rainAt.set(wx, -rain.fall.value, wz).sub(rush).applyQuaternion(turned);

  // Camera z is out of the back of the camera: air or rain going that way
  // is coming at the glass.
  const away = -down.z;
  const coming = Math.max(rainAt.z, 0) / Math.max(rain.fall.value, 0.5);
  const facing = Math.min(coming, 2) + SPRAY * (1 - 0.8 * Math.max(away, 0));

  if (!held) {
    water.step(
      {
        rain: rainfall * facing,
        down: [down.x, -down.y],
        away,
        air: [air.x, -air.y],
        onto: Math.max(air.z, 0),
        aspect: aspect.value,
      },
      delta
    );
  }

  const count = water.count;
  const { threads } = f;
  let drawn = 0;

  for (let k = 0; k < water.threads; k++) {
    water.thread(k, piece);

    if (piece.radius <= 0) continue;
    const e = threads.endData;
    e[drawn * 4] = piece.x0;
    e[drawn * 4 + 1] = piece.y0;
    e[drawn * 4 + 2] = piece.x1;
    e[drawn * 4 + 3] = piece.y1;
    threads.radiusData[drawn] = piece.radius;
    drawn++;
  }

  threads.geometry.instanceCount = drawn;

  if (drawn > 0) {
    threads.ends.clearUpdateRanges();
    threads.ends.addUpdateRange(0, drawn * 4);
    threads.ends.needsUpdate = true;
    threads.radii.clearUpdateRanges();
    threads.radii.addUpdateRange(0, drawn);
    threads.radii.needsUpdate = true;
  }

  wet.value = count > 0 || drawn > 0 ? 1 : 0;
  f.geometry.instanceCount = count;

  if (count === 0 && drawn === 0) return;

  const { places: place, sweeps: sweep } = f;

  for (let i = 0; i < count; i++) {
    water.drawn(i, drop);
    place[i * 4] = drop.x;
    place[i * 4 + 1] = drop.y;
    place[i * 4 + 2] = drop.radius;
    place[i * 4 + 3] = drop.seed;
    sweep[i * 4] = drop.dx;
    sweep[i * 4 + 1] = drop.dy;
    sweep[i * 4 + 2] = drop.stretch;
  }

  f.place.clearUpdateRanges();
  f.place.addUpdateRange(0, count * 4);
  f.place.needsUpdate = true;
  f.sweep.clearUpdateRanges();
  f.sweep.addUpdateRange(0, count * 4);
  f.sweep.needsUpdate = true;

  const previous = renderer.getRenderTarget();
  renderer.getClearColor(clearColor);
  const clearAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(f.target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(f.scene, f.camera);
  renderer.setRenderTarget(previous);
  renderer.setClearColor(clearColor, clearAlpha);
}

/** Wipes the lens dry. */
export function dryLens() {
  water.clear();
  wet.value = 0;
}
