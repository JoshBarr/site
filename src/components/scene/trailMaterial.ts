import { Line2NodeMaterial, Node } from "three/webgpu";
import { diffuseColor } from "three/tsl";

/**
 * Line2NodeMaterial, but blending as usual. Its own transparency mixes over
 * a copy of the opaque scene, which leaves out the sea. Set up as opaque,
 * its opacity is dropped, so it's applied here.
 */
export class TrailMaterial extends Line2NodeMaterial {
  setupDiffuseColor(builder) {
    this.transparent = false;
    super.setupDiffuseColor(builder);
    this.transparent = true;

    if (this.opacityNode) {
      // SAFETY: opacity is a float, whatever node sets it; materials type
      // opacityNode as any node.
      diffuseColor.a.mulAssign(this.opacityNode as Node<"float">);
    }
  }
}
