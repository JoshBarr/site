import { useEffect, useMemo } from "react";
import {
  InstancedBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import {
  attribute,
  cameraPosition,
  exp,
  float,
  log,
  max,
  mix,
  positionGeometry,
  transformNormalToView,
  vec3,
} from "three/tsl";
import { seaLevel } from "../environment";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { CABLES } from "./grid";
import { createRibbonGeometry, hangRibbon } from "./ribbon";

// The HVDC link's cables across Cook Strait. They lie on the sea floor, as
// deep as 250 m, where nothing would show of them: so, past the shallows,
// they're drawn pale and just under the surface instead, and the sea is
// drawn over them as it would be over a sandbank. How far under decides
// how much shows.

/**
 * The sea lets through 1/e of what's seen through this much of it, m (see
 * the opacity in Ocean.tsx).
 */
const SEA_CLEAR = 4;

/** How much of a cable shows through the sea, at its clearest. */
const SHOWS = 0.32;

/** It shows 1/e as much for each this much water over the sea floor, m. */
const FADE_DEPTH = 300;

/** Under the surface at the least, m: below the troughs of a swell. */
const SUNK = 1.5;

/** Over the sea floor where they lie on it, in the shallows, m. */
const PROUD = 0.4;

/**
 * The cables are 12 cm across. They're drawn as if this wide, m, to show
 * from as far as the strait's worth seeing from, but never over
 * MAX_PIXELS: close to, they're a thin line.
 */
const WIDTH = 3;
const MAX_PIXELS = 1;

/** Pale, to show through the water; a real one's black. */
const COLOUR = "#959e99";

function createCableMaterial() {
  const material = new MeshStandardNodeMaterial({
    color: COLOUR,
    roughness: 0.9,
    metalness: 0,
  });

  // Each end's at sea level, with the floor's height there in `w`.
  const start = attribute("start", "vec4");
  const end = attribute("end", "vec4");

  const ribbon = hangRibbon(start.xyz, end.xyz, float(0), float(WIDTH), {
    maxPixels: MAX_PIXELS,
    // Opaque: its edges are the multisampling's.
    fringed: false,
  });

  const floor = mix(start.w, end.w, positionGeometry.x);

  // How much should show: less where it's narrower than its pixel, and
  // over deep water. It's opaque, so it's sunk until that much sea is
  // looked through to see it, the more steeply it's looked down on.
  const shows = ribbon.coverage.mul(SHOWS).mul(exp(floor.div(FADE_DEPTH)));
  const toCamera = cameraPosition.sub(ribbon.position);
  const steepness = toCamera.y.div(toCamera.length()).clamp(0, 1);
  const sunk = max(log(shows).mul(-SEA_CLEAR).mul(steepness), SUNK);

  material.positionNode = ribbon.position.add(
    vec3(0, max(floor.mul(verticalScale).add(PROUD), seaLevel.sub(sunk)), 0)
  );
  // Lit as the sea floor is: from above.
  material.normalNode = transformNormalToView(vec3(0, 1, 0));

  return material;
}

export function Cables({ index }: { index: TileIndex }) {
  const mesh = useMemo(() => {
    const from: number[] = [];
    const to: number[] = [];

    for (const cable of CABLES) {
      const points = cable.map(([easting, northing, floor]) => {
        const [x, z] = nztmToWorld(index.manifest, easting, northing);

        return [x, 0, z, floor];
      });

      for (let i = 1; i < points.length; i++) {
        from.push(...points[i - 1]);
        to.push(...points[i]);
      }
    }

    // A straight piece between each pair of points.
    const geometry = createRibbonGeometry(1);
    geometry.setAttribute(
      "start",
      new InstancedBufferAttribute(new Float32Array(from), 4)
    );
    geometry.setAttribute(
      "end",
      new InstancedBufferAttribute(new Float32Array(to), 4)
    );

    const object = new Mesh(geometry, createCableMaterial());
    object.count = from.length / 4;
    object.frustumCulled = false;
    object.receiveShadow = true;

    return object;
  }, [index]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
    [mesh]
  );

  return <primitive object={mesh} name="Cook Strait cables" />;
}
