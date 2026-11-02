import { useThree } from "@react-three/fiber";
import { WebGPURenderer } from "three/webgpu";

/**
 * The scene's renderer. The Canvas makes a WebGPURenderer (falling back to
 * WebGL inside it), though R3F types it as a WebGLRenderer.
 */
export function useRenderer() {
  const gl = useThree((state) => state.gl);

  if (!(gl instanceof WebGPURenderer)) {
    throw new Error("the scene needs three's WebGPURenderer");
  }

  return gl;
}
