import { useSyncExternalStore } from "react";
import {
  type Camera,
  DepthTexture,
  type Object3D,
  Scene,
  type Texture,
} from "three/webgpu";
import { pass, texture, uniform } from "three/tsl";

// What's drawn over the clouds, in a pass of its own after them: things that
// leave no depth, which the clouds, laid over the scene by its depth, would
// otherwise cover wherever there's sky behind them (a fountain's spray). They
// hold themselves back behind what's in front by the scene's depth, here.

const overClouds = new Scene();

/** The scene pass's depth, which the clouds' pipeline sets as it's built. */
export const sceneDepthNode = texture(new DepthTexture(1, 1));

export function setOverCloudsDepth(depth: Texture) {
  sceneDepthNode.value = depth;
}

/**
 * The pass that draws them, to lay over the picture (premultiplied). It's
 * rendered only while one of them is shown: off screen or too small, its
 * members hide themselves, and then the pass is skipped and lays nothing.
 */
export function overCloudsPass(camera: Camera) {
  // No depth of its own: what's in it tests against the scene's, by hand.
  const drawn = pass(overClouds, camera, { samples: 0, depthBuffer: false });
  const shown = uniform(0);
  const render = drawn.updateBefore.bind(drawn);

  // Run before the picture's own uniforms are sent, so `shown` is this
  // frame's.
  drawn.updateBefore = (frame) => {
    const any = overClouds.children.some((child) => child.visible);
    shown.value = any ? 1 : 0;

    return any ? render(frame) : undefined;
  };

  return drawn.getTextureNode("output").mul(shown);
}

const listeners = new Set<() => void>();

/** Draws `object` over the clouds. Returns a function that takes it off. */
export function addOverClouds(object: Object3D) {
  overClouds.add(object);
  listeners.forEach((listener) => listener());

  return () => {
    overClouds.remove(object);
    listeners.forEach((listener) => listener());
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

/** Whether anything's to be drawn over the clouds: no pass, if not. */
export const useOverClouds = () =>
  useSyncExternalStore(
    subscribe,
    () => overClouds.children.length > 0,
    () => false
  );
