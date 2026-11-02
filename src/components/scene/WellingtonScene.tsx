import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import {
  Box3,
  DirectionalLight,
  Light,
  PerspectiveCamera,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import {
  abs,
  cameraPosition,
  dot,
  float,
  fog,
  max,
  mix,
  positionWorld,
  positionWorldDirection,
  smoothstep,
} from "three/tsl";
import {
  hazeColor,
  hazeDensity,
  hazeDensityForVisibility,
  hazeTransmittance,
  phase,
} from "./haze";
import { hazeGlow } from "./skyglow";
import { Conditions, useConditions } from "./weather";
import { loadManifest, nztmToWorld, TileIndex } from "./terrain/manifest";
import {
  HeightQuery,
  Terrain,
  TERRAIN_DESKTOP,
  TERRAIN_MOBILE,
} from "./terrain/Terrain";
import { SunPosition, sunDirection, sunPosition } from "./sun";
import * as environment from "./environment";
import { Ocean, OCEAN_DESKTOP, OCEAN_MOBILE } from "./ocean/Ocean";
import { OceanConditions, significantHeight } from "./ocean/spectrum";
import { Clouds } from "./clouds/Clouds";
import { CLOUDS_DESKTOP, CLOUDS_MOBILE } from "./clouds/cloudNode";
import { Landmarks } from "./landmarks/Landmarks";
import {
  Buildings,
  BUILDINGS_DESKTOP,
  BUILDINGS_MOBILE,
} from "./buildings/Buildings";
import { windowsLitAt } from "./buildings/material";
import { Trees, TREES_DESKTOP, TREES_MOBILE } from "./trees/Trees";
import { Vessels } from "./vessels/Vessels";
import { Flights } from "./flights/Flights";
import { Railway } from "./trains/Railway";
import { Buses } from "./buses/Buses";
import { Traffic } from "./traffic/Traffic";
import { AirfieldLights } from "./airport/AirfieldLights";
import { updateLens } from "./lens";
import { DEFAULT_FOV, FollowRig } from "./follow/rig";
import { getSnapshot, stop as stopFollowing } from "./follow/store";
import { useRenderer } from "./renderer";

// Over the harbour, looking west across Te Aro to Kelburn.
const START_POSITION: [number, number] = [1752500, 5429000];
const START_ALTITUDE = 900;
const START_TARGET: [number, number] = [1747500, 5428700];
const TARGET_ALTITUDE = 150;

/** Sky samples reach this far for the city's glow, m. */
const SKYGLOW_DISTANCE = 20000;

/**
 * Haze over everything (fog on every material, and the sky), plus a fade
 * toward the edges of the terrain root so the map dissolves instead of ending.
 * At `night` the city lights it from below.
 */
function Atmosphere({
  rootSize,
  conditions,
  night,
}: {
  rootSize: number;
  conditions: Conditions;
  night: boolean;
}) {
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    hazeDensity.value = hazeDensityForVisibility(conditions.visibility);
  }, [conditions.visibility]);

  useEffect(() => {
    const half = rootSize / 2;
    const edge = max(abs(positionWorld.x), abs(positionWorld.z));
    const edgeFade = smoothstep(half * 0.6, half * 0.95, edge);
    const haze = float(1).sub(hazeTransmittance(cameraPosition, positionWorld));

    let fogColor: any = hazeColor(positionWorld.sub(cameraPosition));

    if (night) fogColor = fogColor.add(hazeGlow(cameraPosition, positionWorld));
    scene.fogNode = fog(fogColor, max(haze, edgeFade));

    // Sky: zenith to horizon, hazier toward the horizon, glowing and with a
    // small disc toward the sun.
    const direction = positionWorldDirection;
    const toward = dot(direction, environment.sunDirection);

    const gradient = mix(
      environment.skyHorizon,
      environment.skyZenith,
      smoothstep(0, 0.35, direction.y)
    );

    const horizon = float(1).sub(smoothstep(0, 0.25, max(direction.y, 0)));

    const disc = smoothstep(0.99996, 0.99999, toward).mul(
      environment.sunIntensity.mul(3)
    );

    let sky: any = mix(gradient, hazeColor(direction), horizon.mul(0.8))
      .add(phase(toward, 0.7).mul(environment.sunIntensity).mul(0.15))
      .add(disc);

    if (night) {
      const far = cameraPosition.add(direction.mul(SKYGLOW_DISTANCE));
      sky = sky.add(
        hazeGlow(cameraPosition, far).mul(
          float(1).sub(hazeTransmittance(cameraPosition, far))
        )
      );
    }

    scene.backgroundNode = sky;

    return () => {
      scene.fogNode = null;
      scene.backgroundNode = null;
    };
  }, [scene, rootSize, night]);

  return null;
}

/** Keep the camera at least this far above the ground. */
const GROUND_CLEARANCE = 3;

/** And this far above the tallest wave crests. */
const SEA_CLEARANCE = 1.5;

/** Near plane as a fraction of height above the ground or sea, clamped. */
const NEAR_FRACTION = 0.2;
const NEAR_MIN = 0.3;
const NEAR_MAX = 5;

/** Highest the camera may go: clear of the low deck on most overcast days. */
const CEILING = 4000;
const MIN_DISTANCE = 10;
const MAX_DISTANCE = 14000;
const MAX_POLAR_ANGLE = Math.PI * 0.5;

/**
 * After the layers have put their vehicles where they are this frame, so a
 * followed one sits still in the shot, and before the clouds render it.
 */
const CAMERA_PRIORITY = 0.5;

/** Handing back from following, the orbit target's this far off, m. */
const HAND_BACK: [number, number] = [50, 2000];

/**
 * Keeps the orbit target well inside the terrain so the edge fade stays
 * distant, and the camera above ground. Following a vehicle, the follow rig
 * has the camera instead, without those limits, until it's stopped or the
 * map's touched.
 */
function Controls({
  index,
  heightAt,
  sea,
}: {
  index: TileIndex;
  heightAt: React.RefObject<HeightQuery | null>;
  sea: OceanConditions;
}) {
  const { manifest } = index;
  const half = manifest.rootSize / 2;

  const [position, target] = useMemo(() => {
    // ?cam=E,N,alt,targetE,targetN,targetAlt (NZTM metres) for sharing views.
    const cam = new URLSearchParams(location.search)
      .get("cam")
      ?.split(",")
      .map(Number);

    const [pe, pn, pAlt, te, tn, tAlt] =
      cam?.length === 6 && cam.every(Number.isFinite)
        ? cam
        : [...START_POSITION, START_ALTITUDE, ...START_TARGET, TARGET_ALTITUDE];

    const [px, pz] = nztmToWorld(manifest, pe, pn);
    const [tx, tz] = nztmToWorld(manifest, te, tn);

    return [new Vector3(px, pAlt, pz), new Vector3(tx, tAlt, tz)];
  }, [manifest]);

  const boundary = useMemo(
    () =>
      new Box3(
        // North (negative z) is held furthest from the edge: that's where
        // the land runs off the map.
        new Vector3(-half * 0.6, 0, -half * 0.45),
        new Vector3(half * 0.6, CEILING, half * 0.6)
      ),
    [half]
  );

  const controls = useRef<React.ComponentRef<typeof CameraControls>>(null);
  const orbit = useMemo(() => new Vector3(), []);
  const renderer = useRenderer();

  const connected = useThree((state) => state.events.connected);
  const events = connected instanceof HTMLElement ? connected : undefined;

  // Crests rarely top the significant height, so that's enough headroom.
  const seaFloor = useRef(0);
  seaFloor.current = SEA_CLEARANCE + significantHeight(sea);

  const rig = useMemo(
    () =>
      new FollowRig(
        (e, n) => nztmToWorld(manifest, e, n),
        (x, z) =>
          Math.max(
            (heightAt.current?.(x, z) ?? 0) + GROUND_CLEARANCE,
            seaFloor.current
          )
      ),
    [manifest, heightAt]
  );

  /** Whether the rig has the camera. */
  const followingRef = useRef(false);

  // Back to orbiting, from where the follow rig left the camera.
  const handBack = useCallback(() => {
    const c = controls.current;

    if (!c || !followingRef.current) return;
    followingRef.current = false;
    const { camera } = c;
    c.minDistance = MIN_DISTANCE;
    c.maxDistance = MAX_DISTANCE;
    c.maxPolarAngle = MAX_POLAR_ANGLE;
    c.boundaryEnclosesCamera = true;
    c.setBoundary(boundary);
    c.enabled = true;

    // Orbiting what it was looking at, no higher than the camera.
    const distance = Math.min(
      Math.max(camera.position.distanceTo(rig.shot.target), HAND_BACK[0]),
      HAND_BACK[1]
    );

    camera.getWorldDirection(orbit);
    orbit.multiplyScalar(distance).add(camera.position);
    orbit.y = Math.min(orbit.y, camera.position.y);
    const { x, y, z } = camera.position;
    c.setLookAt(x, y, z, orbit.x, orbit.y, orbit.z, false);
  }, [boundary, rig, orbit]);

  // Touching the map takes the camera back, and carries on as that drag or
  // zoom: this runs before the controls see the event.
  useEffect(() => {
    const element = events ?? renderer.domElement;

    const take = () => {
      if (!getSnapshot().following) return;
      stopFollowing();
      handBack();
    };

    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") stopFollowing();
    };

    element.addEventListener("pointerdown", take, { capture: true });
    element.addEventListener("wheel", take, { capture: true });
    window.addEventListener("keydown", keys);

    return () => {
      element.removeEventListener("pointerdown", take, { capture: true });
      element.removeEventListener("wheel", take, { capture: true });
      window.removeEventListener("keydown", keys);
    };
  }, [events, renderer, handBack]);

  useEffect(() => {
    const c = controls.current;

    if (!c) return;

    c.setBoundary(boundary);
    c.setLookAt(
      position.x,
      position.y,
      position.z,
      target.x,
      target.y,
      target.z,
      false
    );
  }, [boundary, position, target]);

  useFrame((_, delta) => {
    const c = controls.current;

    if (!c || !heightAt.current) return;

    const { camera } = c;

    // The Canvas's camera, which is a perspective one.
    if (!(camera instanceof PerspectiveCamera)) return;

    const shot = rig.update(camera, delta);

    if (shot) {
      if (!followingRef.current) {
        // Out of the orbit's limits: landings are watched from the ground,
        // looking up, and aircraft fly off the edge of the map.
        followingRef.current = true;
        c.setBoundary();
        c.boundaryEnclosesCamera = false;
        c.minDistance = 0;
        c.maxDistance = Infinity;
        c.maxPolarAngle = Math.PI;
        c.enabled = false;
      }

      // Straight onto the camera for this frame, and into the controls so
      // they hold it there through the next.
      const { position: p, target: t } = shot;
      camera.position.copy(p);
      camera.lookAt(t);
      c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
    } else {
      handBack();
    }

    // The lens goes back to the scene's when the rig lets go.
    const fov = shot?.fov ?? DEFAULT_FOV;

    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = shot
        ? fov
        : camera.fov + (fov - camera.fov) * Math.min(delta * 3, 1);
      camera.updateProjectionMatrix();
    }

    const ground = heightAt.current(camera.position.x, camera.position.z);

    if (ground === undefined) return;
    const floor = Math.max(ground + GROUND_CLEARANCE, seaFloor.current);
    const allowed = Math.max(floor, camera.position.y);

    if (camera.position.y !== allowed) {
      const { x, z } = camera.position;

      // The controls only move the camera when they update, and they've
      // already done that this frame: without lifting it here too, every
      // frame of a drag into a hillside renders from under the ground.
      if (!shot) c.setPosition(x, allowed, z, false);
      camera.position.y = allowed;
      camera.lookAt(shot?.target ?? c.getTarget(orbit));
    }

    // Pull the near plane in when low so nearby waves and ground aren't cut
    // off, and push it out when high to keep depth precision for the distance.
    const near = Math.min(
      Math.max((allowed - ground) * NEAR_FRACTION, NEAR_MIN),
      NEAR_MAX
    );

    if (Math.abs(camera.near - near) > camera.near * 0.1) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }

    updateLens(renderer, camera, shot?.target ?? c.getTarget(orbit), delta);
  }, CAMERA_PRIORITY);

  return (
    <CameraControls
      ref={controls}
      makeDefault
      minDistance={MIN_DISTANCE}
      maxDistance={MAX_DISTANCE}
      maxPolarAngle={MAX_POLAR_ANGLE}
      boundaryEnclosesCamera
    />
  );
}

const SUN_DISTANCE = 20000;

/** Width of the shadow-mapped square, centred on SHADOW_CENTRE. */
const SHADOW_EXTENT = 32000;

/** Middle of the high-detail core (NZTM). */
const SHADOW_CENTRE: [number, number] = [1745500, 5429000];

/** Lights are filtered by camera layers too; the reflection needs them. */
const litForReflections = (light: Light | null) =>
  light?.layers.enable(environment.REFLECTION_LAYER);

// Stand-in until the night sky exists: low light from the north-east.
const MOON: [number, number, number] = [0.5, 0.4, -0.75];

/**
 * Night falls through civil twilight, from the sun going behind the hills:
 * sun altitude, degrees. The lights come on one by one through it, and the
 * city's glow in the haze and clouds grows with them.
 */
const DUSK = [4, -6];

/**
 * 0 by day to 1 at night: how far through lighting-up. Each window and lamp
 * has its own moment in it to switch on.
 */
function nightFor(altitude: number) {
  const [start, end] = DUSK;
  const t = Math.min(Math.max((altitude - start) / (end - start), 0), 1);

  return t * t * (3 - 2 * t);
}

/**
 * How often the scene's clock moves on, ms. The sun creeps under a tenth of
 * a degree between ticks, and each re-renders its shadow map.
 */
const CLOCK_TICK = 20000;

/**
 * The scene's moment: now, moving on in real time while the page is open.
 * `?t=<ISO date>` starts it from another time; `?freeze` holds it there.
 */
function useSceneTime() {
  const clock = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const t = params.get("t");

    return {
      start: t ? new Date(t).getTime() : Date.now(),
      openedAt: Date.now(),
      frozen: params.has("freeze"),
    };
  }, []);

  const [time, setTime] = useState(() => new Date(clock.start));

  useEffect(() => {
    if (clock.frozen) return;

    // From the wall clock, not a count of ticks: background tabs skip them.
    const id = setInterval(
      () => setTime(new Date(clock.start + Date.now() - clock.openedAt)),
      CLOCK_TICK
    );

    return () => clearInterval(id);
  }, [clock]);

  return time;
}

/** Sun at its real position over Wellington. */
function Sun({
  index,
  mobile,
  cloudCover,
  position,
}: {
  index: TileIndex;
  mobile: boolean;
  cloudCover: number;
  position: SunPosition;
}) {
  const light = useRef<DirectionalLight>(environment.sunLight);

  const centre = useMemo(() => {
    const [x, z] = nztmToWorld(index.manifest, ...SHADOW_CENTRE);

    return new Vector3(x, 0, z);
  }, [index]);

  const { direction, intensity } = useMemo(() => {
    if (position.altitude < 0) {
      return { direction: MOON, intensity: 0.4 };
    }

    // Fade in through the first few degrees above the horizon.
    const fade = Math.min(1, position.altitude / 6);

    return { direction: sunDirection(position), intensity: 3 * fade };
  }, [position]);

  // Under a full deck the sun barely gets through; light goes flat.
  const lit = intensity * (1 - 0.85 * environment.overcastFor(cloudCover));

  useEffect(() => {
    environment.sunDirection.value.set(...direction);
    environment.sunIntensity.value = lit / 3;
  }, [direction, lit]);

  // The sun moves as the scene's clock runs; its shadows follow.
  useEffect(() => {
    light.current.shadow.needsUpdate = true;
  }, [direction]);

  // One shadow map over the core, independent of the camera. The terrain and
  // sun barely change, so it re-renders only when casters (a cheap stand-in
  // on SHADOW_LAYER) finish loading, not every frame.
  useEffect(() => {
    const sun = light.current;
    const half = SHADOW_EXTENT / 2;
    sun.target.position.copy(centre);
    sun.target.updateMatrixWorld();
    sun.layers.enable(environment.REFLECTION_LAYER);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(mobile ? 2048 : 4096);
    Object.assign(sun.shadow.camera, {
      left: -half,
      right: half,
      top: half,
      bottom: -half,
      near: 1,
      far: SUN_DISTANCE * 3,
    });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.camera.layers.set(environment.SHADOW_LAYER);
    // The casters are coarser than the surface they shade.
    sun.shadow.normalBias = 8;
    sun.shadow.bias = -0.0002;
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
  }, [mobile, centre]);

  const casterVersion = useRef(-1);
  useFrame(() => {
    if (environment.shadowCasters.version !== casterVersion.current) {
      casterVersion.current = environment.shadowCasters.version;
      light.current.shadow.needsUpdate = true;
    }
  });

  const [sunX, sunY, sunZ] = direction.map(
    (v, i) => centre.getComponent(i) + v * SUN_DISTANCE
  );

  return (
    <primitive
      object={environment.sunLight}
      name="sun"
      position={[sunX, sunY, sunZ]}
      intensity={lit}
    />
  );
}

/**
 * Sea state from the wind. Fetch, the open water the wind has blown across,
 * depends on where it comes from: southerlies arrive off the Southern Ocean,
 * northerlies through Cook Strait.
 */
function seaConditions({ wind }: Conditions): OceanConditions {
  const southerly = wind.direction > 120 && wind.direction < 240;

  return {
    windSpeed: wind.speed,
    windDirection: wind.direction,
    fetch: southerly ? 500000 : 80000,
    swell: southerly ? 0.6 : 0.3,
  };
}

function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    setMobile(window.matchMedia("(pointer: coarse)").matches);
  }, []);

  return mobile;
}

/** Everything in the Canvas: Wellington at `time`, under `conditions`. */
export function Scene({
  index,
  conditions,
  time,
  mobile,
}: {
  index: TileIndex;
  conditions: Conditions;
  time: Date;
  mobile: boolean;
}) {
  const heightAt = useRef<HeightQuery | null>(null);
  const sun = useMemo(() => sunPosition(time), [time]);
  const sea = useMemo(() => seaConditions(conditions), [conditions]);
  const lights = nightFor(sun.altitude);

  const setHeightQuery = useCallback((query: HeightQuery | null) => {
    heightAt.current = query;
  }, []);

  return (
    <>
      <ambientLight
        ref={litForReflections}
        intensity={0.25 + 0.3 * environment.overcastFor(conditions.cloudCover)}
      />
      <Atmosphere
        rootSize={index.manifest.rootSize}
        conditions={conditions}
        night={lights > 0}
      />
      <Sun
        index={index}
        mobile={mobile}
        cloudCover={conditions.cloudCover}
        position={sun}
      />
      <Terrain
        onHeightQuery={setHeightQuery}
        index={index}
        quality={mobile ? TERRAIN_MOBILE : TERRAIN_DESKTOP}
      />
      <Suspense fallback={null}>
        <Ocean
          conditions={sea}
          index={index}
          quality={mobile ? OCEAN_MOBILE : OCEAN_DESKTOP}
        />
      </Suspense>
      <Landmarks
        index={index}
        wind={conditions.wind}
        lights={lights}
        shadowMapSize={mobile ? 2048 : 4096}
      />
      <Buildings
        terrain={index}
        quality={mobile ? BUILDINGS_MOBILE : BUILDINGS_DESKTOP}
        lights={lights}
        occupancy={windowsLitAt(time)}
      />
      <Trees
        terrain={index}
        quality={mobile ? TREES_MOBILE : TREES_DESKTOP}
        wind={conditions.wind}
      />
      <AirfieldLights index={index} lights={lights} />
      <Vessels index={index} sea={sea} lights={lights} />
      <Railway index={index} lights={lights} />
      <Traffic index={index} lights={lights} time={time} />
      <Buses index={index} heightAt={heightAt} lights={lights} />
      <Flights
        index={index}
        heightAt={heightAt}
        lights={lights}
        windFrom={conditions.wind.direction}
      />
      <Clouds
        conditions={conditions}
        quality={mobile ? CLOUDS_MOBILE : CLOUDS_DESKTOP}
        night={lights}
      />
      <Controls index={index} heightAt={heightAt} sea={sea} />
    </>
  );
}

/** The Canvas's camera; the controls move its near plane with height. */
export const CAMERA = { fov: DEFAULT_FOV, near: 5, far: 80000 };

export const WellingtonScene: React.FC<{
  /** False clears the sky (and its rain) whatever the forecast says. */
  clouds?: boolean;
}> = ({ clouds = true }) => {
  const [index, setIndex] = useState<TileIndex | null>(null);
  const mobile = useIsMobile();
  const forecast = useConditions();

  const conditions = useMemo(
    () =>
      clouds ? forecast : { ...forecast, cloudCover: 0, precipitation: 0 },
    [forecast, clouds]
  );

  const time = useSceneTime();

  useEffect(() => {
    loadManifest().then(setIndex, (e) => console.error(e));
  }, []);

  return (
    <Canvas
      shadows="percentage"
      dpr={mobile ? [1, 1.5] : [1, 2]}
      gl={async (props) => {
        const renderer = new WebGPURenderer({
          // SAFETY: R3F's props are for a WebGLRenderer, and WebGPURenderer
          // takes the same ones; the types differ only in which declaration
          // of OffscreenCanvas each was built against.
          ...(props as any),
          antialias: true,
          // ?webgl tests the fallback path browsers without WebGPU get.
          forceWebGL: new URLSearchParams(location.search).has("webgl"),
        });

        await renderer.init();

        return renderer;
      }}
      camera={CAMERA}
    >
      {index && (
        <Scene
          index={index}
          conditions={conditions}
          time={time}
          mobile={mobile}
        />
      )}
    </Canvas>
  );
};
