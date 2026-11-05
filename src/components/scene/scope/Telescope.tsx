import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  AmbientLight,
  Color,
  DirectionalLight,
  HalfFloatType,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RenderTarget,
  Scene,
  Vector2,
  Vector3,
} from "three/webgpu";
import {
  clamp,
  dot,
  exp,
  float,
  floor,
  hash,
  length,
  max,
  pow,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { useRenderer } from "../renderer";
import { sight } from "../sky/orbits";
import { limitingMagnitude } from "../sky/skySprites";
import { sunDirection, sunPosition } from "../sun";
import {
  type Craft,
  createCraft,
  disposeCraft,
  type Design,
  designFor,
} from "./craft";
import { createMaterials } from "./surface";
import { IMPOSTOR_DISTANCE, scope } from "./scope";

// The satellite through the telescope: its model, lit by the sun and the
// Earth below it, drawn into a texture from where the camera stands, and
// that texture on a square IMPOSTOR_DISTANCE off along the line to it,
// scaled to look as big as the satellite does from hundreds of km. So it's
// in the scene like anything else: behind the hills, under the clouds,
// graded and focused with the rest. Mounted only while the scope's in use.
//
// Behind it, zoomed in, a made-up field of stars (real ones are far too few
// to land in a frame a few hundredths of a degree across) streaming past
// the way the scope says, streaked as a video frame would. The satellite
// and the stars both go soft as the autofocus hunts.

/**
 * Device pixels across the texture, at most: it's sized to how big the
 * square's drawn, in steps, so it's sharp filling most of a big screen.
 */
const TEXTURE = 1600;
const TEXTURE_STEP = 256;

/** The square's half-width, in the satellite's spans. */
const MARGIN = 0.75;

/** Drawn close up once it's this many device pixels across, or more. */
const SHOWN_FROM = 3;

/** And its point of light goes once it's this many. */
const POINT_UNTIL = 8;

/** The sun on it, as the scene's; the Earth's light on it from below. */
const SUNLIGHT = 3;
const EARTHSHINE = 1.5;

/** Light scattered every way, so a side turned from both isn't featureless. */
const FILL = 0.12;

/** In the Earth's shadow the sun's light on it falls by this much. */
const SHADOWED = 0.75;

const EARTH_RADIUS = 6_371_000;

/** Out of focus all the way, the blur's radius, of the texture. */
const BLUR = 0.02;

/** Taps of the blur: Vogel's spiral, which fills the disc evenly. */
const TAPS = Array.from({ length: 16 }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / 16);
  const angle = i * 2.39996323;

  return [r * Math.cos(angle), r * Math.sin(angle)] as const;
});

/**
 * The stars' plane, m off: just past the satellite's, where the lens is
 * focused, so the depth of field leaves both sharp.
 */
const STAR_DISTANCE = IMPOSTOR_DISTANCE * 1.02;

/** Grid cells a frame's height, about half with a star in. */
const DENSITY = 6;

/** A star's radius, device pixels, and, defocused, how much bigger. */
const STAR_SIZE = 1.3;
const STAR_SOFT = 10;

/** Seconds a frame's exposed for: how long the stars' streaks are. */
const EXPOSURE = 1 / 20;

/** Brightest star. */
const STAR_LIGHT = 4;

/** The satellite's blur, of its texture's width. */
const defocus = uniform(0);

/** How far the stars have drifted, frame heights. */
const starScroll = uniform(new Vector2());

/** The mount's aim off the satellite, frame heights: they shift the other way. */
const starAim = uniform(new Vector2());

/** Each star's way over the exposure, frame heights: streaked back along it. */
const starTrail = uniform(new Vector2());
const starAspect = uniform(1);

/** A device pixel, frame heights. */
const starPixel = uniform(0.001);

/** 0..1: how out of focus. */
const starSoft = uniform(0);
const starsShown = uniform(0);

/** The satellite's texture, blurred by `defocus`. */
function blurred(map: RenderTarget["texture"]) {
  let sum: Node<"vec4"> = texture(map, uv().add(vec2(...TAPS[0]).mul(defocus)));

  for (const tap of TAPS.slice(1)) {
    sum = sum.add(texture(map, uv().add(vec2(...tap).mul(defocus))));
  }

  return sum.div(TAPS.length);
}

/**
 * Stars on a grid, one at a random place in about half the cells: each a
 * soft point drawn along its streak, from the nine cells about.
 */
function starField() {
  const p = uv().sub(0.5).mul(vec2(starAspect, 1));
  const c = p.add(starScroll).add(starAim).mul(DENSITY);
  const base = floor(c);
  const trail = starTrail.mul(DENSITY);
  const along = max(dot(trail, trail), 1e-10);
  const sharp = starPixel.mul(DENSITY * STAR_SIZE);
  const size = sharp.mul(float(1).add(starSoft.mul(STAR_SOFT / STAR_SIZE)));

  // As much light, spread over the blur and along the streak.
  const spread = sharp
    .div(size)
    .pow(2)
    .mul(size.div(size.add(length(trail))));

  let light: Node<"float"> = float(0);

  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      const cell = base.add(vec2(dx, dy));
      // Wrapped, so the hash's seed stays a whole number.
      const wrapped = cell.sub(floor(cell.div(1024)).mul(1024));
      const n = wrapped.x.add(wrapped.y.mul(1024)).mul(4);
      const star = cell.add(vec2(hash(n), hash(n.add(1))));
      const bright = pow(hash(n.add(2)), 5).mul(step(hash(n.add(3)), 0.5));
      const off = c.sub(star);
      const t = clamp(dot(off, trail.negate()).div(along), 0, 1);
      const d = length(off.add(trail.mul(t))).div(size);
      light = light.add(bright.mul(exp(d.mul(d).negate())));
    }
  }

  return vec4(vec3(light.mul(spread).mul(starsShown).mul(STAR_LIGHT)), 1);
}

const RAD = Math.PI / 180;

/** Before the clouds draw the frame (1), after the camera's placed (0.5). */
const TELESCOPE_PRIORITY = 0.9;

function useTelescope() {
  return useMemo(() => {
    const materials = createMaterials();
    const close = new Scene();
    const sunlight = new DirectionalLight(0xffffff, SUNLIGHT);
    // Black space above it, the grey Earth under.
    const earthlight = new HemisphereLight(0x000000, 0xbbbbbb, EARTHSHINE);
    close.add(
      sunlight,
      sunlight.target,
      earthlight,
      new AmbientLight(0xffffff, FILL)
    );
    const camera = new PerspectiveCamera(1, 1, 1, 1000);

    const target = new RenderTarget(TEXTURE_STEP, TEXTURE_STEP, {
      type: HalfFloatType,
      samples: 2,
    });

    // Its depth written where it's drawn (the lens is focused there), not
    // over the clear square about it.
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: true,
      alphaTest: 0.02,
    });

    material.colorNode = blurred(target.texture);

    // Cleared to nothing, so what's drawn is already multiplied by its alpha.
    material.premultipliedAlpha = true;
    material.fog = false;
    const impostor = new Mesh(new PlaneGeometry(1, 1), material);
    impostor.frustumCulled = false;
    impostor.visible = false;
    impostor.name = "telescope";

    // Over the whole frame at the lens's focus, so the sky's not blurred.
    const starMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: true,
      blending: AdditiveBlending,
    });

    starMaterial.colorNode = starField();
    starMaterial.fog = false;
    const stars = new Mesh(new PlaneGeometry(1, 1), starMaterial);
    stars.frustumCulled = false;
    stars.visible = false;
    stars.name = "telescope stars";
    const crafts = new Map<string, Craft>();

    /** The model for `kind`, alone in the close scene. */
    const craftFor = (design: Design) => {
      let craft = crafts.get(design.key);

      if (!craft) {
        craft = createCraft(design, materials);
        crafts.set(design.key, craft);
        close.add(craft.model);
      }

      for (const [key, { model }] of crafts) model.visible = key === design.key;

      return craft;
    };

    const dispose = () => {
      for (const craft of crafts.values()) disposeCraft(craft);

      for (const m of Object.values(materials)) m.dispose();
      target.dispose();
      impostor.geometry.dispose();
      material.dispose();
      stars.geometry.dispose();
      starMaterial.dispose();
    };

    return {
      close,
      camera,
      sunlight,
      earthlight,
      target,
      impostor,
      stars,
      craftFor,
      dispose,
    };
  }, []);
}

const at = new Vector3();
const later = new Vector3();
const up = new Vector3();
const ahead = new Vector3();
const across = new Vector3();
const sun = new Vector3();
const basis = new Matrix4();
const axis = new Vector3();
const spin = new Quaternion();
const cleared = new Color();

/** The satellite close up, in the scene, while the scope's watching one. */
export function Telescope() {
  const renderer = useRenderer();
  const t = useTelescope();

  useEffect(() => t.dispose, [t]);

  useFrame(({ camera, size, viewport }, delta) => {
    const { impostor } = t;
    impostor.visible = false;
    scope.craftShown = false;
    const satellite = scope.satellite;

    if (!satellite || !(camera instanceof PerspectiveCamera)) return;
    drawStars(t.stars, camera, size.height * viewport.dpr, delta);
    // When the camera was aimed, to the millisecond.
    const now = scope.now;
    const seen = sight(satellite, now);
    const next = sight(satellite, now + 1000);

    if (!seen || !next) return;
    const craft = t.craftFor(designFor(satellite.name));
    const { span, tumble } = craft.design;
    const range = seen.range * 1000;

    const pixels =
      (span / range / (camera.fov * RAD)) * size.height * viewport.dpr;

    if (pixels < SHOWN_FROM) return;
    scope.craftShown = pixels > POINT_UNTIL;

    // Where it is from here, m, and its way: its top away from the Earth,
    // its arrays to the sun.
    at.set(...seen.direction).multiplyScalar(range);
    later.set(...next.direction).multiplyScalar(next.range * 1000);
    up.copy(at)
      .setY(at.y + EARTH_RADIUS)
      .normalize();
    ahead.subVectors(later, at);
    ahead.addScaledVector(up, -ahead.dot(up)).normalize();
    across.crossVectors(ahead, up);
    craft.model.quaternion.setFromRotationMatrix(
      basis.makeBasis(ahead, up, across)
    );

    // A spent stage tumbles, about an axis of its own.
    if (tumble) {
      const seed = satellite.id * 0.618;
      axis.set(
        Math.sin(seed * 7),
        0.4 * Math.cos(seed * 3),
        Math.cos(seed * 7)
      );
      craft.model.quaternion.multiply(
        spin.setFromAxisAngle(
          axis.normalize(),
          (tumble * now) / 1000 + seed * 13
        )
      );
    }

    sun.set(...sunDirection(sunPosition(new Date(now))));

    const sunward = later
      .copy(sun)
      .applyQuaternion(craft.model.quaternion.clone().invert());

    for (const arrays of craft.arrays) {
      arrays.rotation.z = Math.atan2(-sunward.x, sunward.y);
    }

    // The light on it: the sun, and the Earth's daylight side under it. In
    // the Earth's shadow, darker, not black: there'd be nothing to see.
    t.sunlight.position.copy(sun).multiplyScalar(100);
    t.sunlight.intensity = SUNLIGHT * (1 - SHADOWED * seen.shade);
    t.earthlight.position.copy(up);
    t.earthlight.intensity =
      EARTHSHINE *
      Math.max(
        0.08 + 0.92 * smoothstep(-0.1, 0.3, up.dot(sun)),
        0.3 * seen.shade
      );

    // Shot square-on from the camera, the frame's way up.
    const shot = t.camera;
    const half = span * MARGIN;
    shot.position.copy(at).negate();
    shot.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    shot.lookAt(0, 0, 0);
    shot.fov = (2 * Math.atan(half / range)) / RAD;
    shot.near = Math.max(range - span * 2, 1);
    shot.far = range + span * 2;
    shot.updateProjectionMatrix();

    // As many texels as the square has pixels, near enough.
    const wanted = Math.min(
      Math.ceil((pixels * 2 * MARGIN) / TEXTURE_STEP) * TEXTURE_STEP,
      TEXTURE
    );

    if (wanted !== t.target.width) t.target.setSize(wanted, wanted);

    const before = renderer.getRenderTarget();
    renderer.getClearColor(cleared);
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(t.target);
    renderer.setClearColor(0x000000, 0);
    renderer.render(t.close, shot);
    renderer.setRenderTarget(before);
    renderer.setClearColor(cleared, alpha);

    // As big from IMPOSTOR_DISTANCE as it is from where it really is.
    const scale = IMPOSTOR_DISTANCE / range;
    impostor.position.copy(camera.position).addScaledVector(at, scale);
    impostor.quaternion.copy(shot.quaternion);
    // Breathing a little as the focus hunts.
    impostor.scale.setScalar(2 * half * scale * (1 + 0.012 * scope.focus));
    impostor.visible = true;
    defocus.value = BLUR * Math.abs(scope.focus);
  }, TELESCOPE_PRIORITY);

  return (
    <>
      <primitive object={t.stars} />
      <primitive object={t.impostor} />
    </>
  );
}

/**
 * The stars' plane over the frame, scrolled on as the scope says they're
 * drifting: shown zoomed in, dimmer by day.
 */
function drawStars(
  stars: Mesh,
  camera: PerspectiveCamera,
  height: number,
  delta: number
) {
  const shown =
    smoothstep(0.35, 0.8, scope.zoom) *
    (0.5 + 0.5 * smoothstep(-6, 3, limitingMagnitude.value));

  stars.visible = shown > 0;

  if (!stars.visible) {
    starScroll.value.set(0, 0);

    return;
  }

  const { drift, offset } = scope;
  // Scrolled the way they go, and moved with the mount's aim off.
  starScroll.value.addScaledVector(drift, -delta);
  starTrail.value.copy(drift).multiplyScalar(EXPOSURE);
  starAim.value.copy(offset);
  starsShown.value = shown;
  starAspect.value = camera.aspect;
  starPixel.value = 1 / Math.max(height, 1);
  starSoft.value = Math.abs(scope.focus);

  const tall = 2 * STAR_DISTANCE * Math.tan((camera.fov * RAD) / 2);
  stars.quaternion.copy(camera.quaternion);
  stars.position
    .set(0, 0, -STAR_DISTANCE)
    .applyQuaternion(camera.quaternion)
    .add(camera.position);
  stars.scale.set(tall * camera.aspect, tall, 1);
}

function smoothstep(lo: number, hi: number, x: number) {
  const u = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);

  return u * u * (3 - 2 * u);
}
