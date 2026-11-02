import {
  BufferGeometry,
  InstancedMesh,
  Material,
  Matrix4,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import { attribute, uniform } from "three/tsl";
import { pixelAngle } from "../landmarks/common";
import { castsNearShadow } from "../landmarks/nearShadow";

// Vehicles in two levels of detail: everyone's low-poly shape, packed into
// one instanced mesh per family, and, for the few close enough to see
// properly, a detailed model of what they are.

/** Longer than this on screen, pixels, a vehicle is drawn in detail. */
const NEAR_PIXELS = 64;

/** Whether something `length` m long, `distance` m away, is drawn in detail. */
export function isNear(length: number, distance: number) {
  return length > distance * pixelAngle.value * NEAR_PIXELS;
}

/**
 * Material for detailed models: their own baked colours, and their windows'
 * glow times `lit`, 0 by day to 1 at night.
 */
export function createModelMaterial({
  roughness = 0.6,
  metalness = 0,
}: {
  roughness?: number;
  metalness?: number;
} = {}) {
  const lit = uniform(0);
  const material = new MeshStandardNodeMaterial({ roughness, metalness });
  material.colorNode = attribute<"vec3">("color", "vec3");
  material.emissiveNode = attribute<"vec3">("glow", "vec3").mul(lit);

  return { material, lit };
}

/**
 * The detailed instances of one model, packed afresh each frame: `begin`,
 * `add` each near one, then `end`.
 */
export class NearModels {
  readonly mesh: InstancedMesh;
  private count = 0;

  constructor(
    geometry: BufferGeometry,
    material: Material,
    readonly capacity: number
  ) {
    this.mesh = new InstancedMesh(geometry, material, capacity);
    // Instances move every frame; their bounds would always be stale.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    castsNearShadow(this.mesh);
  }

  begin() {
    this.count = 0;
  }

  /** False when there's no room: draw it the simple way instead. */
  add(matrix: Matrix4) {
    if (this.count >= this.capacity) return false;
    this.mesh.setMatrixAt(this.count, matrix);
    this.count++;

    return true;
  }

  end() {
    const shown = this.count > 0;

    if (shown || this.mesh.visible) {
      this.mesh.instanceMatrix.needsUpdate = true;
    }

    this.mesh.count = this.count;
    this.mesh.visible = shown;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

/** A zero-size matrix, for slots in the simple mesh drawn in detail instead. */
export const HIDDEN = new Matrix4().makeScale(0, 0, 0);
