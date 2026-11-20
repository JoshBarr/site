import { useEffect, useMemo } from "react";
import {
  DoubleSide,
  InstancedBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import { attribute, transformNormalToView } from "three/tsl";
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

/** Weathered aluminium, dark as it reads against hills and sky. */
const COLOUR = "#474c4f";

function createWireMaterial() {
  const material = new MeshStandardNodeMaterial({
    color: COLOUR,
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
  material.opacityNode = ribbon.coverage.pow(FADE).mul(ribbon.edge);

  return material;
}

/**
 * The conductors and earth wires, every one in a single draw: `wires` is
 * WIRE_STRIDE floats to a wire (see network.ts).
 */
export function Wires({ wires }: { wires: Float32Array }) {
  const mesh = useMemo(() => {
    const count = wires.length / WIRE_STRIDE;
    const from = new Float32Array(count * 3);
    const to = new Float32Array(count * 3);
    const hang = new Float32Array(count * 2);

    for (let i = 0; i < count; i++) {
      const wire = wires.subarray(i * WIRE_STRIDE, (i + 1) * WIRE_STRIDE);
      from.set(wire.subarray(0, 3), i * 3);
      to.set(wire.subarray(3, 6), i * 3);
      hang.set(wire.subarray(6, 8), i * 2);
    }

    const geometry = createRibbonGeometry(SEGMENTS);
    geometry.setAttribute("start", new InstancedBufferAttribute(from, 3));
    geometry.setAttribute("end", new InstancedBufferAttribute(to, 3));
    geometry.setAttribute("hang", new InstancedBufferAttribute(hang, 2));

    const object = new Mesh(geometry, createWireMaterial());
    object.count = count;
    // Wires are placed in the shader; the geometry's bounds mean nothing.
    object.frustumCulled = false;
    // After the sea, which would otherwise be blended over them.
    object.renderOrder = 2;

    return object;
  }, [wires]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
    [mesh]
  );

  return <primitive object={mesh} name="power lines" />;
}
