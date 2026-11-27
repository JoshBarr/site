import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Mesh, MeshStandardNodeMaterial } from "three/webgpu";
import { attribute, vec3 } from "three/tsl";
import { nztmToWorld, type TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { seaLevel } from "../environment";
import { castsNearShadow } from "../landmarks/nearShadow";
import { BREAKWATERS, PONTOONS } from "./marinaOutlines";
import { createSolidsGeometry, type Solid } from "./marinaGeometry";

// The marinas' pontoons and breakwaters (scripts/vessels/marinas.mjs): the
// walkways and fingers the moored boats (Moored.tsx) lie alongside, which
// float, and the breakwaters round them the terrain's too coarse to have,
// Clyde Quay's thin concrete walls and the rock mounds at Seaview, Evans Bay
// and Mana. Heights are guesses, from photos.

/** A pontoon's deck above the water, and its float below it, m. */
const FREEBOARD = 0.5;
const DRAUGHT = 0.6;

/** A concrete breakwater's top above mean sea level, m, and its foot. */
const WALL_CREST = 2.2;
const WALL_FOOT = -3;

/** A rock breakwater's crest, its foot, and how far its foot spreads, m. */
const ROCK_CREST = 3;
const ROCK_FOOT = -2;
const ROCK_SPREAD = 2.5;

/**
 * Greys, the tops' and the sides': weathered concrete, darker than the white
 * boats, and floats darker still, as in photos of Chaffers.
 */
const PONTOON_TONE: Solid["tone"] = [0.3, 0.16];
const WALL_TONE: Solid["tone"] = [0.36, 0.3];
const ROCK_TONE: Solid["tone"] = [0.26, 0.22];

function createMaterial() {
  const material = new MeshStandardNodeMaterial({ roughness: 0.9 });
  material.colorNode = vec3(attribute<"float">("tone", "float"));

  return material;
}

/** The marinas' pontoons, riding the tide, and their breakwaters. */
export function Marinas({ index }: { index: TileIndex }) {
  const { pontoons, breakwaters, dispose } = useMemo(() => {
    const scale = verticalScale.value;

    const toWorld = (easting: number, northing: number) =>
      nztmToWorld(index.manifest, easting, northing);

    const material = createMaterial();

    const pontoons = new Mesh(
      createSolidsGeometry(
        PONTOONS.map((outline) => ({
          outline,
          top: FREEBOARD,
          bottom: -DRAUGHT,
          batter: 0,
          tone: PONTOON_TONE,
        })),
        toWorld
      ),
      material
    );

    const breakwaters = new Mesh(
      createSolidsGeometry(
        BREAKWATERS.map(({ rock, outline }) => ({
          outline,
          top: (rock ? ROCK_CREST : WALL_CREST) * scale,
          bottom: (rock ? ROCK_FOOT : WALL_FOOT) * scale,
          batter: rock ? ROCK_SPREAD : 0,
          tone: rock ? ROCK_TONE : WALL_TONE,
        })),
        toWorld
      ),
      material
    );

    castsNearShadow(pontoons);
    castsNearShadow(breakwaters);

    return {
      pontoons,
      breakwaters,
      dispose: () => {
        pontoons.geometry.dispose();
        breakwaters.geometry.dispose();
        material.dispose();
      },
    };
  }, [index]);

  useEffect(() => dispose, [dispose]);

  useFrame(() => {
    // Afloat, they ride the tide, as the boats do.
    pontoons.position.y = seaLevel.value;
  });

  return (
    <>
      <primitive object={pontoons} name="pontoons" />
      <primitive object={breakwaters} name="breakwaters" />
    </>
  );
}
