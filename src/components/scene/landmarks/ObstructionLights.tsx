import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  InstancedBufferAttribute,
  Sprite,
  SpriteNodeMaterial,
} from "three/webgpu";
import {
  cameraPosition,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  max,
  mix,
  smoothstep,
  sqrt,
  step,
  time,
  uv,
  vec3,
} from "three/tsl";
import { hazeTransmittance } from "../haze";
import { obstructionLights, pixelAngle } from "./common";

export interface ObstructionLight {
  position: [number, number, number];
  /** Medium-intensity lights on turbines flash, each on its own clock. */
  flashing?: boolean;
}

/** Flashes per minute for flashing lights, as seen at Wellington's farms. */
const FLASHES_PER_MINUTE = 2;

/** How long each flash stays lit, in seconds. */
const FLASH_SECONDS = 1;

/** Each light runs this much fast or slow, so they drift in and out of step. */
const RATE_SPREAD = 0.08;

/** Deterministic 0..1 noise from an integer, so lights keep their timing. */
function hash(i: number, salt: number) {
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;

  return s - Math.floor(s);
}

/**
 * Never smaller than this many pixels across. Real ones are a pixel or two
 * at range but dazzle; a screen can't, so they're drawn big and soft instead.
 */
const MIN_PIXELS = 14;
const SIZE = 6;

/** Aviation red lights: steady on towers, flashing on turbines. Off by day. */
export function ObstructionLights({ lights }: { lights: ObstructionLight[] }) {
  const sprite = useMemo(() => {
    const data = new Float32Array(lights.length * 4);
    // Phase (0..1 of a cycle), rate (× FLASHES_PER_MINUTE) and how far
    // through lighting-up it comes on, per light: each has its own photocell.
    const timing = new Float32Array(lights.length * 3);
    lights.forEach(({ position, flashing }, i) => {
      data.set([...position, flashing ? 1 : 0], i * 4);
      timing.set(
        [hash(i, 1), 1 + (hash(i, 2) * 2 - 1) * RATE_SPREAD, hash(i, 3)],
        i * 3
      );
    });

    const light = instancedBufferAttribute<"vec4">(
      new InstancedBufferAttribute(data, 4),
      "vec4"
    );

    const clock = instancedBufferAttribute<"vec3">(
      new InstancedBufferAttribute(timing, 3),
      "vec3"
    );

    const position = light.xyz;

    const material = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    // They glow rather than fog. Haze dims them, but only partly: they're far
    // brighter than anything they're seen against.
    material.fog = false;
    material.positionNode = position;
    const distance = cameraPosition.distance(position);
    material.scaleNode = max(
      float(SIZE),
      distance.mul(pixelAngle).mul(MIN_PIXELS)
    );

    const period = 60 / FLASHES_PER_MINUTE;
    // Seconds into this light's cycle.
    const t = fract(time.mul(clock.y).div(period).add(clock.x)).mul(period);

    const flash = smoothstep(0, 0.1, t).mul(
      float(1).sub(smoothstep(FLASH_SECONDS * 0.7, FLASH_SECONDS, t))
    );

    const on = mix(float(1), flash, light.w).mul(
      step(clock.z, obstructionLights)
    );

    const r = uv().sub(0.5).length().mul(2);
    // A hot core in a soft halo.
    const glow = exp(r.mul(r).mul(-40)).add(exp(r.mul(-4.5)).mul(0.4));
    const fade = float(1).sub(smoothstep(0.85, 1, r));
    material.colorNode = vec3(1, 0.07, 0.03)
      .mul(glow.mul(fade).mul(on).mul(3))
      .mul(sqrt(hazeTransmittance(cameraPosition, position)));

    const object = new Sprite(material);
    object.count = lights.length;
    object.frustumCulled = false;
    object.renderOrder = 10;

    return object;
  }, [lights]);

  // Sprites share one quad geometry; only the material is ours.
  useEffect(() => () => sprite.material.dispose(), [sprite]);

  useFrame(() => {
    sprite.visible = obstructionLights.value > 0;
  });

  return <primitive object={sprite} />;
}
