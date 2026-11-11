import React, { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { Color, WebGPURenderer } from "three/webgpu";
import GUI from "lil-gui";
import { obstructionLights, usePixelAngle } from "./common";
import { LatticeTower, towerLights } from "./LatticeTower";
import { KAUKAU_TOWER, MT_VICTORIA_TOWER } from "./latticeGeometry";
import { ObstructionLights } from "./ObstructionLights";
import { turbineLights } from "./turbineLights";
import { E_44, SWT_2_3_82 } from "./turbineModels";
import { Wind, WindTurbines } from "./WindTurbines";
import { applyToneMapping } from "../tone";

// Standalone bench for the landmark assets: each on flat ground, with the
// wind, time and light under control. /landmarks

type Point = [number, number, number];

const KAUKAU: Point = [0, 0, 0];
const MT_VICTORIA: Point = [-70, 0, 40];
const BROOKLYN: Point = [110, 0, 10];

/** A small ridge-line farm. */
const FARM: Point[] = [
  [300, 0, -120],
  [520, 0, -60],
  [740, 0, -150],
  [960, 0, -80],
  [420, 0, 180],
  [660, 0, 230],
];

const VIEWS = new Map(
  Object.entries({
    "Mt Kaukau": [
      [130, 45, 170],
      [0, 55, 0],
    ],
    "Mt Victoria": [
      [-20, 18, 100],
      [-70, 22, 40],
    ],
    Brooklyn: [
      [170, 30, 80],
      [110, 38, 10],
    ],
    "Brooklyn rotor": [
      [113, 46, 34],
      [110, 46, 10],
    ],
    "Siemens farm": [
      [380, 50, 520],
      [620, 60, 0],
    ],
    "Siemens nacelle": [
      [330, 75, -80],
      [300, 68, -120],
    ],
    "Everything, 2 km": [
      [500, 250, 2000],
      [450, 40, 0],
    ],
    "Everything, 9 km": [
      [500, 500, 9000],
      [450, 40, 0],
    ],
  } satisfies Record<string, [Point, Point]>)
);

interface Settings {
  windSpeed: number;
  windDirection: number;
  timeScale: number;
  night: boolean;
  /** Compass bearing of the sun (or moon). */
  sun: number;
  view: string;
}

function Lighting({ night, sun }: { night: boolean; sun: number }) {
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    scene.background = new Color(night ? "#0a0d14" : "#a9bccb");
    obstructionLights.value = night ? 1 : 0;
  }, [scene, night]);

  return (
    <>
      <ambientLight intensity={night ? 0.08 : 0.35} />
      <directionalLight
        position={[
          Math.sin((sun * Math.PI) / 180) * 700,
          night ? 300 : 500,
          -Math.cos((sun * Math.PI) / 180) * 700,
        ]}
        intensity={night ? 0.25 : 3}
        color={night ? "#9fb0d0" : "#fff6ea"}
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.3}
        shadow-camera-left={-1200}
        shadow-camera-right={1200}
        shadow-camera-top={1200}
        shadow-camera-bottom={-1200}
        shadow-camera-far={3000}
      />
    </>
  );
}

function Ground({ night }: { night: boolean }) {
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={-0.05} receiveShadow>
      <planeGeometry args={[60000, 60000]} />
      <meshStandardMaterial
        color={night ? "#20251f" : "#5d6955"}
        roughness={1}
      />
    </mesh>
  );
}

function View({ view }: { view: string }) {
  const controls = useRef<React.ComponentRef<typeof CameraControls>>(null);
  useEffect(() => {
    const found = VIEWS.get(view);

    if (!found) return;

    const [[px, py, pz], [tx, ty, tz]] = found;
    controls.current?.setLookAt(px, py, pz, tx, ty, tz, true);
  }, [view]);

  return (
    <CameraControls
      ref={controls}
      makeDefault
      minDistance={5}
      maxDistance={20000}
    />
  );
}

function Assets({ settings }: { settings: Settings }) {
  usePixelAngle();

  const wind: Wind = useMemo(
    () => ({ speed: settings.windSpeed, direction: settings.windDirection }),
    [settings.windSpeed, settings.windDirection]
  );

  const brooklyn = useMemo(() => [BROOKLYN], []);

  const lights = useMemo(
    () => [
      ...turbineLights(SWT_2_3_82, FARM),
      ...towerLights(KAUKAU_TOWER, KAUKAU),
      ...towerLights(MT_VICTORIA_TOWER, MT_VICTORIA),
    ],
    []
  );

  return (
    <>
      <LatticeTower spec={KAUKAU_TOWER} position={KAUKAU} />
      <LatticeTower spec={MT_VICTORIA_TOWER} position={MT_VICTORIA} />
      <WindTurbines
        model={E_44}
        positions={brooklyn}
        wind={wind}
        timeScale={settings.timeScale}
      />
      <WindTurbines
        model={SWT_2_3_82}
        positions={FARM}
        wind={wind}
        timeScale={settings.timeScale}
      />
      <ObstructionLights lights={lights} />
    </>
  );
}

/** ?view=Brooklyn&wind=12,300&time=20&sun=150&night to start from a given state. */
function initialSettings(): Settings {
  const params = new URLSearchParams(location.search);

  const [speed, direction] = (params.get("wind") ?? "7,340")
    .split(",")
    .map(Number);

  const view = params.get("view");

  return {
    windSpeed: Number.isFinite(speed) ? speed : 7,
    windDirection: Number.isFinite(direction) ? direction : 340,
    timeScale: Number(params.get("time")) || 1,
    night: params.has("night"),
    sun: Number(params.get("sun") ?? 300),
    view: view && VIEWS.has(view) ? view : "Siemens farm",
  };
}

function useSettings() {
  const [settings, setSettings] = useState<Settings>(initialSettings);

  useEffect(() => {
    const values = { ...settings };
    const gui = new GUI({ title: "Landmarks" });
    const update = () => setSettings({ ...values });
    gui
      .add(values, "windSpeed", 0, 40, 0.5)
      .name("wind m/s (10 m)")
      .onChange(update);
    gui
      .add(values, "windDirection", 0, 360, 5)
      .name("wind from °")
      .onChange(update);
    gui.add(values, "timeScale", 1, 60, 1).name("time ×").onChange(update);
    gui.add(values, "night").onChange(update);
    gui.add(values, "sun", 0, 360, 5).name("sun bearing °").onChange(update);
    gui.add(values, "view", [...VIEWS.keys()]).onChange(update);

    return () => gui.destroy();
    // The GUI owns its copy; built once.
  }, []);

  return settings;
}

export const LandmarksPreview: React.FC = () => {
  const settings = useSettings();

  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 2]}
      gl={async (props) => {
        const renderer = new WebGPURenderer({
          // SAFETY: R3F's props are for a WebGLRenderer, and WebGPURenderer
          // takes the same ones; the types differ only in which declaration
          // of OffscreenCanvas each was built against.
          ...(props as any),
          antialias: true,
          forceWebGL: new URLSearchParams(location.search).has("webgl"),
        });

        await renderer.init();

        return renderer;
      }}
      camera={{ fov: 50, near: 1, far: 80000, position: [0, 50, 300] }}
      // As the scene: after R3F has put in its default, ACES.
      onCreated={({ gl }) => applyToneMapping(gl)}
    >
      <Lighting night={settings.night} sun={settings.sun} />
      <Ground night={settings.night} />
      <Assets settings={settings} />
      <View view={settings.view} />
    </Canvas>
  );
};
