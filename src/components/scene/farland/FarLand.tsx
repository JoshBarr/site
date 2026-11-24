import { useEffect, useMemo, useState } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
} from "three/webgpu";
import {
  cameraPosition,
  dot,
  max,
  min,
  mix,
  normalGeometry,
  normalize,
  positionGeometry,
  positionWorld,
  smoothstep,
  step,
  uniform,
  varying,
  vec3,
} from "three/tsl";
import {
  skyBrightness,
  skylight,
  sunDirection,
  sunIntensity,
} from "../environment";
import { track } from "../loading";
import { skyAlong } from "../sky/backdrop";
import type { TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { clearTo, earthDrop } from "./air";
import { type FarLandMesh, loadFarLand } from "./mesh";

// The South Island on the horizon: the Marlborough Sounds across Cook
// Strait, 30 to 60 km off, and behind them the Richmond and Kaikōura ranges,
// out to 190 km. One coarse mesh (see ./mesh.ts), far past the terrain's
// edge, where it's always seen through a lot of air (./air.ts): a grey shape
// a little darker than the sky, its tops clearer than its feet, gone in bad
// weather. The sea (../ocean) runs on out around it.

/** However clear the air or high the camera, it shows no more than this. */
const MOST = 0.6;

/** How far under the sea the land's drawn, m. */
const UNDER = 3;

/** Albedos, in the terrain's greys: bush and pasture, bare tops, snow. */
const BUSH = 0.07;
const ROCK = 0.2;
const SNOW = 0.8;

/** Where the bush gives out to rock and scree, m. */
const BUSHLINE = [900, 1500];

/**
 * The snowline through the year, m: down to SNOW_LOW in late August, up to
 * SNOW_HIGH (only Tapuae-o-Uenuku's top) in late February. A guess at an
 * average year.
 */
const SNOW_LOW = 1200;
const SNOW_HIGH = 2600;
const SNOW_HIGHEST_DAY = 55;

/** The snow thins out over this much height either side of its line, m. */
const SNOW_EDGE = 150;

const DAY = 86_400_000;
const YEAR = 365.25;

/** The height snow lies above at `time`, m. */
export function snowlineAt(time: Date) {
  const day = (time.getTime() - Date.UTC(time.getUTCFullYear(), 0, 1)) / DAY;
  const season = Math.cos(((day - SNOW_HIGHEST_DAY) / YEAR) * 2 * Math.PI);

  return (SNOW_HIGH + SNOW_LOW) / 2 + ((SNOW_HIGH - SNOW_LOW) / 2) * season;
}

const snowline = uniform(SNOW_HIGH);

function createMaterial(rootSize: number) {
  const material = new MeshBasicNodeMaterial();

  // Its own haze, below: the scene's fog fades everything out at the
  // terrain's edge, which this is past.
  material.fog = false;

  // As surveyed: metres above the sea, on a flat Earth.
  const height = positionGeometry.y;

  // Stood on the scene's flat sea, it sinks with distance as the Earth
  // curves away, and its sea with it.
  const lifted = height.mul(verticalScale);

  material.positionNode = vec3(
    positionGeometry.x,
    lifted.sub(earthDrop(positionGeometry.xz, rootSize)),
    positionGeometry.z
  );

  // Through the haze to where it really is, not where it's drawn.
  const shows = varying(
    min(clearTo(vec3(positionGeometry.x, lifted, positionGeometry.z)), MOST)
  );

  // Lit as the terrain is, near enough: the sun on the slopes facing it,
  // the sky on them all. Less the fill the night's skylight has for the eye
  // adapting to the dark: it doesn't, to snow 100 km off.
  const light = varying(
    max(dot(normalGeometry, sunDirection), 0)
      .mul(sunIntensity)
      .mul(3 / Math.PI)
      .add(skylight.mul(skyBrightness).div(Math.PI))
  );

  const level = varying(height);

  const albedo = mix(
    mix(BUSH, ROCK, smoothstep(BUSHLINE[0], BUSHLINE[1], level)),
    SNOW,
    smoothstep(snowline.sub(SNOW_EDGE), snowline.add(SNOW_EDGE), level)
  );

  // What's left of it, over the sky that's behind it: less the sun's disc
  // and the moon, which set behind the ranges.
  const behind = skyAlong(normalize(positionWorld.sub(cameraPosition)));

  material.colorNode = mix(behind, vec3(albedo.mul(light)), shows);

  // The coasts: the mesh's triangles run on out to sea, under it. Drawn to
  // a little under, for the scene's sea, where it reaches, to lap at a low
  // tide.
  material.opacityNode = step(-UNDER, level);
  material.alphaTest = 0.5;

  return material;
}

function createMesh({ positions, indices }: FarLandMesh, rootSize: number) {
  const geometry = new BufferGeometry();

  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const mesh = new Mesh(geometry, createMaterial(rootSize));

  // The shader moves it: its bounds aren't where it's drawn.
  mesh.frustumCulled = false;

  return mesh;
}

export function FarLand({ index, time }: { index: TileIndex; time: Date }) {
  const [land, setLand] = useState<FarLandMesh | null>(null);

  useEffect(() => {
    let stopped = false;

    track(loadFarLand(index.manifest)).then(
      (loaded) => {
        if (!stopped) setLand(loaded);
      },
      (e) => console.error("[far land]", e)
    );

    return () => {
      stopped = true;
    };
  }, [index]);

  const mesh = useMemo(
    () => land && createMesh(land, index.manifest.rootSize),
    [land, index]
  );

  useEffect(
    () => () => {
      mesh?.geometry.dispose();
      mesh?.material.dispose();
    },
    [mesh]
  );

  const snow = snowlineAt(time);

  useEffect(() => {
    snowline.value = snow;
  }, [snow]);

  return mesh && <primitive object={mesh} name="South Island" />;
}
