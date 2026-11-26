import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import {
  DoubleSide,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  Vector3,
} from "three/webgpu";
import { switchedOff } from "../stats";
import { TileIndex } from "../terrain/manifest";
import { railBores } from "../tunnels/bores";
import { Bores } from "../tunnels/Tunnels";
import { type Crossing, loadCrossings, Watch } from "./crossingWatch";
import { Crossings } from "./Crossings";
import { createTrackChunks } from "./geometry";
import { loadRailNetwork, loadStations, RailNetwork } from "./network";
import { Trains } from "./Trains";

/**
 * Track is drawn this near the camera, m, and dropped once twice as far:
 * beyond, a bed 4 m wide is under a pixel.
 */
const TRACK_RANGE = 6000;

const cameraPosition = new Vector3();

/**
 * The track along every line on the map, out of the tunnels, and
 * Wellington station's platforms (or the cable car's line). Each chunk is
 * built when the camera first comes near it, the nearest first, one a
 * frame.
 */
export function Tracks({ network }: { network: RailNetwork }) {
  const camera = useThree((state) => state.camera);

  const { group, material, chunks } = useMemo(
    () => ({
      group: new Group(),
      material: new MeshStandardNodeMaterial({
        vertexColors: true,
        roughness: 0.9,
        side: DoubleSide,
      }),
      chunks: createTrackChunks(network).map(
        (chunk): typeof chunk & { mesh: Mesh | null } => ({
          ...chunk,
          mesh: null,
        })
      ),
    }),
    [network]
  );

  useEffect(
    () => () => {
      for (const chunk of chunks) chunk.mesh?.geometry.dispose();
      group.clear();
      material.dispose();
    },
    [group, material, chunks]
  );

  useFrame(() => {
    camera.getWorldPosition(cameraPosition);
    let next: (typeof chunks)[number] | null = null;
    let nearest = TRACK_RANGE;

    for (const chunk of chunks) {
      const distance = chunk.box.distanceToPoint(cameraPosition);

      if (chunk.mesh) {
        chunk.mesh.visible = distance < TRACK_RANGE;

        if (distance > TRACK_RANGE * 2) {
          group.remove(chunk.mesh);
          chunk.mesh.geometry.dispose();
          chunk.mesh = null;
        }
      } else if (distance < nearest) {
        nearest = distance;
        next = chunk;
      }
    }

    if (next) {
      next.mesh = new Mesh(next.build(), material);
      next.mesh.receiveShadow = true;
      group.add(next.mesh);
    }
  });

  return <primitive object={group} name="railway track" />;
}

/** `?crossings=down` holds every level crossing down, for looking at them. */
const crossingsDown = () =>
  new URLSearchParams(location.search).get("crossings") === "down";

/**
 * The railway: its track near the camera, its tunnels, Metlink's trains
 * running live wherever they are on the map, and the level crossings
 * flashing for them.
 * `lights` (0..1), how far through lighting-up, lights the trains for night.
 */
export function Railway({
  index,
  lights = 0,
}: {
  index: TileIndex;
  lights?: number;
}) {
  const [network, setNetwork] = useState<RailNetwork | null>(null);
  const [crossings, setCrossings] = useState<Crossing[] | null>(null);
  const [stations, setStations] = useState<[number, number][]>([]);

  useEffect(() => {
    loadRailNetwork(index).then(setNetwork, (e) => console.error(e));

    // Without them trains stand only where their track runs out, or when
    // they're held.
    loadStations(index).then(setStations, (e) => console.error(e));

    // Without them the trains still run.
    if (!switchedOff("crossings")) {
      loadCrossings(index).then(setCrossings, (e) => console.error(e));
    }
  }, [index]);

  const bores = useMemo(() => network && railBores(network), [network]);

  const watch = useMemo(
    () => crossings && new Watch(crossings, crossingsDown()),
    [crossings]
  );

  if (!network || !bores) return null;

  return (
    <>
      <Tracks network={network} />
      {!switchedOff("tunnels") && <Bores bores={bores} name="rail tunnels" />}
      <Trains
        index={index}
        network={network}
        stations={stations}
        lights={lights}
        watch={watch}
      />
      {watch && <Crossings watch={watch} />}
    </>
  );
}
