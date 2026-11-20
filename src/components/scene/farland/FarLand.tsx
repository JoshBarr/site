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
  exp,
  max,
  min,
  mix,
  normalGeometry,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
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
import { hazeTransmittance } from "../haze";
import { track } from "../loading";
import { skyAlong } from "../sky/backdrop";
import type { TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { type FarLandMesh, loadFarLand } from "./mesh";

// The South Island on the horizon: the Marlborough Sounds across Cook
// Strait, 30 to 60 km off, and behind them the Richmond and Kaikōura ranges,
// out to 190 km. One coarse mesh (see ./mesh.ts), far past the terrain's
// edge, where it's always seen through a lot of air: a grey shape a little
// darker than the sky, its tops clearer than its feet, gone in bad weather.

/** The Earth's radius, m, and how much of its curve refraction undoes. */
const EARTH_RADIUS = 6371000;
const REFRACTION = 0.13;

/** What the land sinks by, m, for the square of its distance, m². */
const CURVE = (1 - REFRACTION) / (2 * EARTH_RADIUS);

/**
 * Of the haze's optical depth between the camera and the land, how much
 * counts. The scene's haze is thick, to give 60 km of ground some depth:
 * through all of it nothing 50 km off would show, on any day. Out over the
 * strait it's taken to be this much thinner.
 */
const THINNER = 0.25;

/**
 * And the air itself, haze or none, lets 1/e through for each this far, m:
 * about what clean air scatters between here and the ranges' tops, which
 * stand above the haze. Together, on a day you can see 30 km across the
 * harbour, the Sounds show at about a fifth of their contrast and the
 * Kaikōuras' tops likewise, their feet less; at 10 km none of it does.
 */
const AIR = 150000;

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

function createMaterial() {
  const material = new MeshBasicNodeMaterial();

  // Its own haze, below: the scene's fog fades everything out at the
  // terrain's edge, which this is past.
  material.fog = false;

  // As surveyed: metres above the sea, on a flat Earth.
  const height = positionGeometry.y;

  // Stood on the scene's flat sea, it sinks with distance as the Earth
  // curves away from wherever the camera is: the far ranges are hull down,
  // more so from the shore than from the hills.
  const away = positionGeometry.xz.sub(cameraPosition.xz);
  const lifted = height.mul(verticalScale);

  material.positionNode = vec3(
    positionGeometry.x,
    lifted.sub(dot(away, away).mul(CURVE)),
    positionGeometry.z
  );

  // Through the haze to where it really is, not where it's drawn: the air
  // curves with the Earth.
  const at = vec3(positionGeometry.x, lifted, positionGeometry.z);

  const clear = pow(hazeTransmittance(cameraPosition, at), THINNER).mul(
    exp(at.distance(cameraPosition).div(-AIR))
  );

  const shows = varying(min(clear, MOST));

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

function createMesh({ positions, indices }: FarLandMesh) {
  const geometry = new BufferGeometry();

  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const mesh = new Mesh(geometry, createMaterial());

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

  const mesh = useMemo(() => land && createMesh(land), [land]);

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
