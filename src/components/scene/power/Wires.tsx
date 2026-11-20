import { useEffect, useMemo } from "react";
import {
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import {
  attribute,
  mix,
  positionGeometry,
  transformNormalToView,
  uniform,
  varying,
} from "three/tsl";
import { gridDims, gridGlow, gridLight } from "./energise";
import { WIRE_STRIDE } from "./network";
import { createRibbonGeometry, hangRibbon } from "./ribbon";

/** Quads along each wire: enough that its sag reads as a curve. */
const SEGMENTS = 12;

/**
 * A wire narrower than its pixel fills only so much of it, and should be
 * that faint: but then a line's gone within a kilometre, and they're what
 * the eye follows across the hills. So they fade by this power of it.
 */
const FADE = 0.7;

/** Once a wire fills less than this of its pixel, it's left out. */
const FAINTEST = 0.008;

/**
 * Lit (see energise.ts), a wire's a line of light, and fades by this power
 * instead: a line can be followed to the skyline.
 */
const LIT_FADE = 0.3;

/** Weathered aluminium, dark as it reads against hills and sky. */
const COLOUR = "#474c4f";

function createWireMaterial() {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.5,
    metalness: 0,
    side: DoubleSide,
    // Blended, not dithered like the towers: a faint line stays a line.
    transparent: true,
    depthWrite: false,
  });

  const hang = attribute("hang", "vec2");

  const ribbon = hangRibbon(
    attribute("start", "vec3"),
    attribute("end", "vec3"),
    hang.x,
    hang.y,
    { faintest: FAINTEST }
  );

  material.positionNode = ribbon.position;
  material.normalNode = transformNormalToView(ribbon.normal);

  // How hard its line's working at either end, and whether it's the HVDC
  // link's: for when the grid's lit.
  const carries = attribute("carries", "vec3");

  const glow: any = varying(
    gridGlow(ribbon.position, {
      level: mix(carries.x, carries.y, positionGeometry.x),
      link: carries.z,
    })
  );

  material.colorNode = uniform(new Color(COLOUR)).mul(gridDims(glow));
  material.emissiveNode = gridLight(glow);
  material.opacityNode = mix(
    ribbon.coverage.pow(FADE),
    ribbon.coverage.pow(LIT_FADE),
    glow.clamp(0, 1)
  ).mul(ribbon.edge);

  return material;
}

/**
 * The conductors and earth wires, every one in a single draw: `wires` is
 * WIRE_STRIDE floats to a wire (see network.ts). `carrying` is for when
 * the grid's lit (see energise.ts): how hard each wire's line is working at
 * either end (`levels`, a pair to a wire, 0..1) and whether it's the HVDC
 * link's (`link`). Without it, they're any line's at its most.
 */
export function Wires({
  wires,
  carrying,
}: {
  wires: Float32Array;
  carrying?: { levels: Float32Array; link: Uint8Array };
}) {
  const link = carrying?.link;
  const levels = carrying?.levels;

  const mesh = useMemo(() => {
    const count = wires.length / WIRE_STRIDE;
    const from = new Float32Array(count * 3);
    const to = new Float32Array(count * 3);
    const hang = new Float32Array(count * 2);
    const carries = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const wire = wires.subarray(i * WIRE_STRIDE, (i + 1) * WIRE_STRIDE);
      from.set(wire.subarray(0, 3), i * 3);
      to.set(wire.subarray(3, 6), i * 3);
      hang.set(wire.subarray(6, 8), i * 2);
      // Its levels are filled in below, and again whenever they change.
      carries.set([1, 1, link?.[i] ?? 0], i * 3);
    }

    const geometry = createRibbonGeometry(SEGMENTS);
    geometry.setAttribute("start", new InstancedBufferAttribute(from, 3));
    geometry.setAttribute("end", new InstancedBufferAttribute(to, 3));
    geometry.setAttribute("hang", new InstancedBufferAttribute(hang, 2));
    geometry.setAttribute("carries", new InstancedBufferAttribute(carries, 3));

    const object = new Mesh(geometry, createWireMaterial());
    object.count = count;
    // Wires are placed in the shader; the geometry's bounds mean nothing.
    object.frustumCulled = false;
    // After the sea, which would otherwise be blended over them.
    object.renderOrder = 2;

    return object;
  }, [wires, link]);

  useEffect(() => {
    const carries = mesh.geometry.getAttribute("carries");

    for (let i = 0; i < carries.count; i++) {
      carries.setXY(i, levels?.[i * 2] ?? 1, levels?.[i * 2 + 1] ?? 1);
    }

    carries.needsUpdate = true;
  }, [mesh, levels]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
    [mesh]
  );

  return <primitive object={mesh} name="power lines" />;
}
