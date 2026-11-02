import { useEffect, useMemo } from "react";
import {
  BoxGeometry,
  Color,
  InstancedBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import {
  attribute,
  normalGeometry,
  positionGeometry,
  transformNormalToView,
  vec3,
} from "three/tsl";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { random, rotateY } from "../landmarks/common";
import { castsNearShadow } from "../landmarks/nearShadow";
import type { YardBlock } from "./terminal";

// ISO boxes, m.
const FORTY = 12.19;
const TWENTY = 6.06;
const WIDTH = 2.44;
const STANDARD = 2.59;
const HIGH_CUBE = 2.9;

/** Straddle carriers need about this between rows; ends nearly touch. */
const ROW_GAP = 1.6;
const END_GAP = 0.6;

/** Share of slots standing empty. */
const EMPTY = 0.2;

/** Share of stacks made of pairs of twenty-footers. */
const TWENTIES = 0.3;

/** Monochrome, like the ships' cargo: light to dark greys. */
const SHADES = [
  "#a6a6a6",
  "#8a8a8a",
  "#6e6e6e",
  "#5a5a5a",
  "#b8b8b8",
  "#d8d8d8",
  "#7c7c7c",
].map((hex) => new Color(hex).r);

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Per box: world position of its base centre and yaw (`place`), and
 * length, height and grey (`box`).
 */
function stack(index: TileIndex, yard: YardBlock[], wharfBearing: number) {
  const place: number[] = [];
  const box: number[] = [];
  let seed = 0;
  const next = () => random(seed++);

  // World x/z of a step along the wharf and seaward across it.
  const along = radians(wharfBearing);
  const seaward = radians(wharfBearing - 90);
  const u = [Math.sin(along), -Math.cos(along)];
  const v = [Math.sin(seaward), -Math.cos(seaward)];

  for (const block of yard) {
    const [e, n, ground] = block.site;
    const [cx, cz] = nztmToWorld(index.manifest, e, n);
    const y = ground * verticalScale.value;

    const lengthwise = block.lie === "along" ? u : v;
    const sideways = block.lie === "along" ? v : u;
    const long = block.lie === "along" ? block.along : block.across;
    const wide = block.lie === "along" ? block.across : block.along;
    // Rotation about +y that lays a box's length (+x) along `lengthwise`.
    const yaw = Math.PI / 2 - (block.lie === "along" ? along : seaward);

    const lanes = Math.max(1, Math.floor((long + END_GAP) / (FORTY + END_GAP)));
    const rows = Math.max(1, Math.floor((wide + ROW_GAP) / (WIDTH + ROW_GAP)));

    for (let lane = 0; lane < lanes; lane++) {
      for (let row = 0; row < rows; row++) {
        if (next() < EMPTY) continue;

        const tiers = Math.min(
          block.tiers,
          1 + Math.floor(block.tiers * next() ** 0.8)
        );

        const twenties = next() < TWENTIES;
        const a = (lane - (lanes - 1) / 2) * (FORTY + END_GAP);
        const b = (row - (rows - 1) / 2) * (WIDTH + ROW_GAP);

        const slots = twenties
          ? [-(TWENTY / 2 + 0.04), TWENTY / 2 + 0.04]
          : [0];

        let top = y;

        for (let tier = 0; tier < tiers; tier++) {
          const height = next() < 0.5 ? HIGH_CUBE : STANDARD;

          for (const offset of slots) {
            // Never quite stacked square.
            const along = a + offset + (next() - 0.5) * 0.2;
            const across = b + (next() - 0.5) * 0.2;
            place.push(
              cx + lengthwise[0] * along + sideways[0] * across,
              top,
              cz + lengthwise[1] * along + sideways[1] * across,
              yaw + radians((next() - 0.5) * 1)
            );
            box.push(
              twenties ? TWENTY : FORTY,
              height,
              SHADES[Math.floor(next() * SHADES.length)],
              0
            );
          }

          top += height;
        }
      }
    }
  }

  return { place: new Float32Array(place), box: new Float32Array(box) };
}

/** Container stacks on the wharf, instanced boxes. */
export function ContainerYard({
  index,
  yard,
  wharfBearing,
}: {
  index: TileIndex;
  yard: YardBlock[];
  /** Compass bearing the wharf runs along; the yard is square to it. */
  wharfBearing: number;
}) {
  const mesh = useMemo(() => {
    const { place, box } = stack(index, yard, wharfBearing);
    const geometry = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    geometry.setAttribute("place", new InstancedBufferAttribute(place, 4));
    geometry.setAttribute("box", new InstancedBufferAttribute(box, 4));

    const p = attribute("place", "vec4");
    const b = attribute("box", "vec4");

    const material = new MeshStandardNodeMaterial({
      roughness: 0.7,
      metalness: 0,
    });

    material.positionNode = rotateY(
      positionGeometry.mul(vec3(b.x, b.y, WIDTH)),
      p.w
    ).add(p.xyz);
    material.normalNode = transformNormalToView(rotateY(normalGeometry, p.w));
    material.colorNode = vec3(b.z);

    const object = new Mesh(geometry, material);
    object.count = place.length / 4;
    // Boxes are placed in the shader; the geometry's bounds mean nothing.
    object.frustumCulled = false;
    castsNearShadow(object);

    return object;
  }, [index, yard, wharfBearing]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
    [mesh]
  );

  return <primitive object={mesh} name="container yard" />;
}
