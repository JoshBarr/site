import React, { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { Color, Vector3, WebGPURenderer } from "three/webgpu";
import {
  cameraPosition,
  dot,
  float,
  fog,
  mix,
  positionWorld,
  positionWorldDirection,
  smoothstep,
} from "three/tsl";
import GUI from "lil-gui";
import * as environment from "../environment";
import {
  hazeColor,
  hazeDensity,
  hazeHeight,
  hazeTransmittance,
  phase,
} from "../haze";
import { showSky, skyFor, skyRadiance, skyStage } from "../sky/skyModel";
import { updateLens } from "../lens";
import { Conditions } from "../weather";
import { Clouds } from "./Clouds";
import { CLOUDS_DESKTOP, CLOUDS_MOBILE } from "./cloudNode";
import { applyToneMapping } from "../tone";

// Standalone bench for the clouds: the real march over a flat sea, with the
// weather, sun and view under control. Spin the camera to see the march's
// jitter; ?off=cloudhistory to see it without the frames averaged. /clouds

type Point = [number, number, number];

const VIEWS = new Map(
  Object.entries({
    "Harbour, 900 m": [
      [0, 900, 0],
      [-5000, 150, -300],
    ],
    "Sea level": [
      [0, 20, 0],
      [-5000, 700, 0],
    ],
    "Under the base": [
      [0, 400, 0],
      [-3000, 1400, 0],
    ],
    "Above the tops": [
      [0, 3500, 0],
      [-6000, 1000, 0],
    ],
    "Distant, 15 km": [
      [0, 300, 0],
      [-15000, 1200, 0],
    ],
  } satisfies Record<string, [Point, Point]>)
);

interface Settings {
  /** Percent. */
  cover: number;
  base: number;
  windSpeed: number;
  windDirection: number;
  sunAltitude: number;
  /** Compass bearing. */
  sunBearing: number;
  mobile: boolean;
  /** Turns the camera, degrees a second: the jitter shows as it moves. */
  spin: number;
  view: string;
}

/** Haze over the sea and a plain sky, as the scene's Atmosphere has. */
function Sky() {
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    const haze = float(1).sub(hazeTransmittance(cameraPosition, positionWorld));
    scene.fogNode = fog(hazeColor(positionWorld.sub(cameraPosition)), haze);

    const direction = positionWorldDirection;
    const toward = dot(direction, environment.sunDirection);

    const gradient = mix(
      environment.skyHorizon,
      mix(environment.skyZenith, environment.skyHorizon, environment.overcast),
      smoothstep(0, 0.35, direction.y)
    );

    const horizon = float(1).sub(smoothstep(0, 0.25, direction.y.max(0)));

    // From the sky model, the day's sky is its own, glow and all.
    const air = skyStage()
      ? skyRadiance(direction)
      : gradient.add(
          phase(toward, 0.7).mul(environment.sunIntensity).mul(0.15)
        );

    scene.backgroundNode = mix(air, hazeColor(direction), horizon.mul(0.8)).add(
      smoothstep(0.99996, 0.99999, toward).mul(environment.sunIntensity.mul(3))
    );

    return () => {
      scene.fogNode = null;
      scene.backgroundNode = null;
    };
  }, [scene]);

  return (
    <mesh rotation-x={-Math.PI / 2}>
      <planeGeometry args={[160000, 160000]} />
      <meshStandardMaterial color={new Color("#1d3440")} roughness={0.9} />
    </mesh>
  );
}

function Sun({ altitude, bearing, cover }) {
  const direction = useMemo(() => {
    const a = (altitude * Math.PI) / 180;
    const b = (bearing * Math.PI) / 180;

    // x east, z south.
    return new Vector3(
      Math.sin(b) * Math.cos(a),
      Math.sin(a),
      -Math.cos(b) * Math.cos(a)
    );
  }, [altitude, bearing]);

  // The light from the sky model, as far as the scene takes it (?sky=).
  const stage = skyStage();

  const sky = useMemo(
    () =>
      stage ? skyFor(altitude, hazeDensity.value, hazeHeight.value) : null,
    [stage, altitude]
  );

  const sun = stage >= 2 && sky ? sky.sun : 3;
  const lit = sun * (1 - 0.85 * environment.overcastFor(cover));

  const skylight = environment.skylightFor(
    cover,
    1,
    stage >= 3 && sky ? sky.sky : null
  );

  useEffect(() => {
    environment.sunDirection.value.copy(direction);
    environment.sunIntensity.value = lit / 3;
    environment.skylight.value = skylight;

    if (sky) showSky(sky, [direction.x, direction.y, direction.z], 0, 0, cover);
  }, [direction, lit, cover, sky, skylight]);

  return (
    <>
      <ambientLight intensity={skylight} />
      <directionalLight position={direction.clone()} intensity={lit} />
    </>
  );
}

/** Racks the depth of field to the orbit target, as the scene does. */
function View({ view, spin }: { view: string; spin: number }) {
  const controls = useRef<React.ComponentRef<typeof CameraControls>>(null);
  const renderer = useThree((state) => state.gl);
  const target = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const found = VIEWS.get(view);

    if (!found) return;

    const [[px, py, pz], [tx, ty, tz]] = found;
    controls.current?.setLookAt(px, py, pz, tx, ty, tz, false);
  }, [view]);

  useFrame(({ camera }, delta) => {
    if (!controls.current || !(renderer instanceof WebGPURenderer)) return;

    if (spin) controls.current.rotate((spin * Math.PI * delta) / 180, 0, false);

    updateLens(renderer, camera, controls.current.getTarget(target), delta);
  });

  return (
    <CameraControls
      ref={controls}
      makeDefault
      minDistance={10}
      maxDistance={40000}
    />
  );
}

/**
 * ?cover=35&base=900&wind=10,340&sun=30,300&view=Sea+level&spin=2 to start
 * from a given state; ?cam=x,y,z,tx,ty,tz for any view (metres, y up);
 * ?mobile for the mobile march.
 */
function initialSettings(): Settings {
  const params = new URLSearchParams(location.search);

  const pair = (name: string, fallback: [number, number]) => {
    const [a, b] = (params.get(name) ?? "").split(",").map(Number);

    return params.has(name) && Number.isFinite(a) && Number.isFinite(b)
      ? [a, b]
      : fallback;
  };

  const number = (name: string, fallback: number) => {
    const value = Number(params.get(name));

    return params.has(name) && Number.isFinite(value) ? value : fallback;
  };

  const [windSpeed, windDirection] = pair("wind", [10, 340]);
  const [sunAltitude, sunBearing] = pair("sun", [30, 300]);

  const cam = (params.get("cam") ?? "").split(",").map(Number);

  if (cam.length === 6 && cam.every(Number.isFinite)) {
    VIEWS.set("From ?cam", [
      [cam[0], cam[1], cam[2]],
      [cam[3], cam[4], cam[5]],
    ]);
  }

  const view = params.has("cam") ? "From ?cam" : params.get("view");

  return {
    cover: number("cover", 35),
    base: number("base", 900),
    windSpeed,
    windDirection,
    sunAltitude,
    sunBearing,
    mobile: params.has("mobile"),
    spin: number("spin", 0),
    view: view && VIEWS.has(view) ? view : "Harbour, 900 m",
  };
}

function useSettings() {
  const [settings, setSettings] = useState<Settings>(initialSettings);

  useEffect(() => {
    const values = { ...settings };
    const gui = new GUI({ title: "Clouds" });
    const update = () => setSettings({ ...values });

    const weather = gui.addFolder("Weather");
    weather.add(values, "cover", 0, 100, 1).name("cover %").onChange(update);
    weather.add(values, "base", 200, 2500, 50).name("base m").onChange(update);
    weather
      .add(values, "windSpeed", 0, 40, 0.5)
      .name("wind aloft m/s")
      .onChange(update);
    weather
      .add(values, "windDirection", 0, 360, 5)
      .name("wind from °")
      .onChange(update);

    const sun = gui.addFolder("Sun");
    sun
      .add(values, "sunAltitude", 1, 90, 1)
      .name("altitude °")
      .onChange(update);
    sun.add(values, "sunBearing", 0, 360, 5).name("bearing °").onChange(update);

    gui.add(values, "mobile").name("mobile quality").onChange(update);
    gui.add(values, "spin", -10, 10, 0.5).name("spin °/s").onChange(update);
    gui.add(values, "view", [...VIEWS.keys()]).onChange(update);

    return () => gui.destroy();
    // The GUI owns its copy; built once.
  }, []);

  return settings;
}

export const CloudsPreview: React.FC = () => {
  const settings = useSettings();

  const conditions: Conditions = useMemo(
    () => ({
      time: new Date(0).toISOString(),
      cloudCover: settings.cover / 100,
      cloudBase: settings.base,
      visibility: 30000,
      humidity: 0.7,
      precipitation: 0,
      wind: {
        speed: settings.windSpeed / 1.4,
        direction: settings.windDirection,
      },
      windAloft: {
        speed: settings.windSpeed,
        direction: settings.windDirection,
      },
    }),
    [settings.cover, settings.base, settings.windSpeed, settings.windDirection]
  );

  return (
    <Canvas
      // As the scene: 1.5× at most.
      dpr={[1, 1.5]}
      gl={async (props) => {
        const renderer = new WebGPURenderer({
          // SAFETY: R3F's props are for a WebGLRenderer, and WebGPURenderer
          // takes the same ones; the types differ only in which declaration
          // of OffscreenCanvas each was built against.
          ...(props as any),
          antialias: true,
        });

        await renderer.init();

        return renderer;
      }}
      camera={{ fov: 50, near: 5, far: 80000, position: [0, 900, 0] }}
      // As the scene: after R3F has put in its default, ACES.
      onCreated={({ gl }) => applyToneMapping(gl)}
    >
      <Sky />
      <Sun
        altitude={settings.sunAltitude}
        bearing={settings.sunBearing}
        cover={conditions.cloudCover}
      />
      <Clouds
        conditions={conditions}
        quality={settings.mobile ? CLOUDS_MOBILE : CLOUDS_DESKTOP}
      />
      <View view={settings.view} spin={settings.spin} />
    </Canvas>
  );
};
