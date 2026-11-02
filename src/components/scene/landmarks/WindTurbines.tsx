import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import {
  attribute,
  cameraPosition,
  float,
  max,
  normalGeometry,
  positionGeometry,
  transformNormalToView,
  vec3,
} from "three/tsl";
import { pixelAngle, random, rotateX, rotateY, rotateZ } from "./common";
import { castsNearShadow } from "./nearShadow";
import {
  createBladeGeometry,
  createNacelleGeometry,
  createTowerGeometry,
  towerTop,
  typicalChord,
} from "./turbineGeometry";
import {
  FEATHERED,
  operatingPoint,
  shouldRun,
  TurbineModel,
  windAtHub,
} from "./turbineModels";

export interface Wind {
  /** m/s at 10 m. */
  speed: number;
  /** Degrees clockwise from north that it blows from. */
  direction: number;
}

/** Thin parts are drawn at least this many pixels wide. */
const MIN_PIXELS = 0.9;
/** Gusts, as a fraction of the mean wind. */
const TURBULENCE = 0.15;
/** How long the controller averages wind over to start or stop, s. */
const START_AVERAGING = 30;
/** Nacelles slew once the averaged misalignment passes this, and stop near zero. */
const YAW_DEADBAND = (8 * Math.PI) / 180;
const YAW_SETTLED = (1 * Math.PI) / 180;
/** Fastest pitch change, radians per second. */
const PITCH_RATE = (6 * Math.PI) / 180;

const TAU = 2 * Math.PI;
const wrap = (angle: number) => angle - TAU * Math.round(angle / TAU);

/** Smooth, irregular wobble in -1..1 over tens of seconds. */
function gust(t: number, phase: number) {
  return (
    0.5 * Math.sin(TAU * 0.011 * t + phase) +
    0.32 * Math.sin(TAU * 0.029 * t + 1.3 + phase * 1.7) +
    0.18 * Math.sin(TAU * 0.073 * t + 2.1 + phase * 2.3)
  );
}

interface TurbineState {
  /** Compass bearing the rotor faces, radians. */
  yaw: number;
  yawing: boolean;
  misalignment: number;
  running: boolean;
  averageWind: number;
  rpm: number;
  pitch: number;
  angle: number;
}

/**
 * Turbines of one model, drawn instanced in three parts (tower, nacelle with
 * spinner, blades). Each faces into the wind and turns at the speed its
 * controller would choose for the wind at its hub.
 *
 * `positions` are world [x, y, z] of each tower base.
 */
export function WindTurbines({
  model,
  positions,
  wind,
  timeScale = 1,
}: {
  model: TurbineModel;
  positions: [number, number, number][];
  wind: Wind;
  /** Speeds up the simulation, e.g. to watch nacelles slew. */
  timeScale?: number;
}) {
  const windRef = useRef(wind);
  windRef.current = wind;
  const timeScaleRef = useRef(timeScale);
  timeScaleRef.current = timeScale;

  const parts = useMemo(
    () => createTurbineMeshes(model, positions),
    [model, positions]
  );
  useEffect(() => () => parts.dispose(), [parts]);

  // Per-turbine variety: exposure on its ridge, how it sits to the wind.
  const variety = useMemo(
    () =>
      positions.map((_, i) => ({
        exposure: 0.9 + 0.25 * random(i * 3 + 1),
        yawOffset: ((random(i * 3 + 2) - 0.5) * 8 * Math.PI) / 180,
        phase: random(i * 3 + 3) * TAU,
      })),
    [positions]
  );

  const state = useRef<TurbineState[] | null>(null);
  const time = useRef(0);

  useEffect(() => {
    state.current = null;
  }, [parts]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1) * timeScaleRef.current;
    const t = (time.current += dt);
    const { speed, direction } = windRef.current;
    const from = (direction * Math.PI) / 180;
    const hubWind = windAtHub(model, speed);

    if (!state.current) {
      // Start settled: facing the wind (within the deadband), up to speed.
      state.current = positions.map((_, i) => {
        const wind = hubWind * variety[i].exposure;
        const running = shouldRun(model, wind, false);
        const { rpm, pitch } = operatingPoint(model, wind, running);
        return {
          yaw:
            from + variety[i].yawOffset + (random(i * 7) - 0.5) * YAW_DEADBAND,
          yawing: false,
          misalignment: 0,
          running,
          averageWind: wind,
          rpm,
          pitch,
          angle: random(i * 5) * TAU,
        };
      });
    }

    // Gusts sweep downwind through the farm: each turbine sees the shared
    // gust a little after the ones upwind of it.
    const towardX = -Math.sin(from);
    const towardZ = Math.cos(from);
    const travel = Math.max(hubWind, 1);
    const spin = parts.blades.geometry.getAttribute(
      "pose"
    ) as InstancedBufferAttribute;
    const facing = parts.nacelles.geometry.getAttribute(
      "pose"
    ) as InstancedBufferAttribute;

    state.current.forEach((turbine, i) => {
      const { exposure, yawOffset, phase } = variety[i];
      const [x, , z] = positions[i];
      const delay = (x * towardX + z * towardZ) / travel;
      const fluctuation = 0.65 * gust(t - delay, 0) + 0.35 * gust(t, phase);
      const wind = Math.max(
        hubWind * exposure * (1 + TURBULENCE * fluctuation),
        0
      );

      turbine.averageWind +=
        (wind - turbine.averageWind) * (1 - Math.exp(-dt / START_AVERAGING));
      turbine.running = shouldRun(model, turbine.averageWind, turbine.running);

      const target = operatingPoint(model, wind, turbine.running);
      // Bigger rotors carry more inertia.
      const spinUp = model.rotorRadius / 8;
      turbine.rpm += (target.rpm - turbine.rpm) * (1 - Math.exp(-dt / spinUp));
      const pitchStep = target.pitch - turbine.pitch;
      turbine.pitch +=
        Math.sign(pitchStep) * Math.min(Math.abs(pitchStep), PITCH_RATE * dt);
      turbine.angle = (turbine.angle + (turbine.rpm / 60) * TAU * dt) % TAU;

      // Yaw: act on the averaged error, then slew at the drive's rate.
      if (speed > 1) {
        const wander = ((5 * Math.PI) / 180) * gust(t * 1.7, phase + 2);
        const error = wrap(from + yawOffset + wander - turbine.yaw);
        turbine.misalignment +=
          (error - turbine.misalignment) * (1 - Math.exp(-dt / 15));
        if (!turbine.yawing && Math.abs(turbine.misalignment) > YAW_DEADBAND) {
          turbine.yawing = true;
        }
        if (turbine.yawing) {
          const step = ((model.yawRate * Math.PI) / 180) * dt;
          turbine.yaw = wrap(
            turbine.yaw + Math.sign(error) * Math.min(Math.abs(error), step)
          );
          if (Math.abs(error) < YAW_SETTLED) turbine.yawing = false;
        }
      }

      // The meshes face +z; turn that to face the bearing (x east, z south).
      const heading = Math.PI - turbine.yaw;
      facing.setX(i, heading);
      for (let b = 0; b < 3; b++) {
        spin.setXYZ(
          i * 3 + b,
          heading,
          turbine.angle + (b * TAU) / 3,
          turbine.pitch
        );
      }
    });
    facing.needsUpdate = true;
    spin.needsUpdate = true;
  });

  return (
    <group>
      <primitive object={parts.towers} />
      <primitive object={parts.nacelles} />
      <primitive object={parts.blades} />
    </group>
  );
}

/** Instanced per-turbine data: tower base, and (yaw, rotor angle, pitch). */
function instanced(
  geometry: BufferGeometry,
  positions: [number, number, number][],
  copies: number
) {
  const count = positions.length * copies;
  const site = new Float32Array(count * 4);
  const pose = new Float32Array(count * 4);
  positions.forEach(([x, y, z], i) => {
    for (let c = 0; c < copies; c++) {
      site.set([x, y, z, i], (i * copies + c) * 4);
      pose.set([0, 0, FEATHERED, 0], (i * copies + c) * 4);
    }
  });
  geometry.setAttribute("site", new InstancedBufferAttribute(site, 4));
  const poseAttribute = new InstancedBufferAttribute(pose, 4);
  poseAttribute.setUsage(DynamicDrawUsage);
  geometry.setAttribute("pose", poseAttribute);
  return count;
}

function createTurbineMeshes(
  model: TurbineModel,
  positions: [number, number, number][]
) {
  const site = attribute("site", "vec4");
  const pose = attribute("pose", "vec4");
  const top = site.xyz.add(vec3(0, towerTop(model), 0));

  // How many metres one pixel covers at this turbine.
  const pixel = cameraPosition
    .distance(top.add(vec3(0, model.hubAbove, 0)))
    .mul(pixelAngle);
  const widen = (width: number) =>
    max(float(1), pixel.mul(MIN_PIXELS).div(width));

  const material = () =>
    new MeshStandardNodeMaterial({
      color: model.colour,
      roughness: 0.55,
      metalness: 0,
    });

  // Towers: widened about their axis when far away.
  const towerWiden = widen(model.towerTopRadius * 2);
  const towerMaterial = material();
  towerMaterial.positionNode = positionGeometry
    .mul(vec3(towerWiden, 1, towerWiden))
    .add(site.xyz);
  // Shadows are rendered from the sun's side: true size, never widened.
  towerMaterial.castShadowPositionNode = positionGeometry.add(site.xyz);

  // Nacelles: turned by yaw.
  const nacelleMaterial = material();
  nacelleMaterial.positionNode = rotateY(positionGeometry, pose.x).add(top);
  nacelleMaterial.normalNode = transformNormalToView(
    rotateY(normalGeometry, pose.x)
  );

  // Blades: pitch about the span, cone, spin about the shaft, then the
  // shaft's tilt and the nacelle's yaw.
  const bladeWiden = widen(typicalChord(model));
  const orient = (v, withOffsets: boolean) => {
    let p: any = rotateY(v, pose.z.negate());
    p = rotateX(p, model.cone);
    p = rotateZ(p, pose.y.negate());
    if (withOffsets) p = p.add(vec3(0, 0, model.overhang));
    p = rotateX(p, -model.tilt);
    if (withOffsets) p = p.add(vec3(0, model.hubAbove, 0));
    p = rotateY(p, pose.x);
    return withOffsets ? p.add(top) : p;
  };
  const bladeMaterial = material();
  bladeMaterial.positionNode = orient(
    positionGeometry.mul(vec3(bladeWiden, 1, bladeWiden)),
    true
  );
  bladeMaterial.castShadowPositionNode = orient(positionGeometry, true);
  bladeMaterial.normalNode = transformNormalToView(
    orient(normalGeometry, false)
  );

  const mesh = (
    geometry: BufferGeometry,
    material: MeshStandardNodeMaterial,
    copies: number
  ) => {
    const object = new Mesh(geometry, material);
    object.count = instanced(geometry, positions, copies);
    // Instances are placed in the shader; the geometry's bounds mean nothing.
    object.frustumCulled = false;
    castsNearShadow(object);
    return object;
  };

  const towers = mesh(createTowerGeometry(model), towerMaterial, 1);
  const nacelles = mesh(createNacelleGeometry(model), nacelleMaterial, 1);
  const blades = mesh(createBladeGeometry(model), bladeMaterial, 3);

  return {
    towers,
    nacelles,
    blades,
    dispose() {
      for (const object of [towers, nacelles, blades]) {
        object.geometry.dispose();
        (object.material as MeshStandardNodeMaterial).dispose();
      }
    },
  };
}
