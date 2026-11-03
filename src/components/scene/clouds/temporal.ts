import {
  Camera,
  HalfFloatType,
  Matrix4,
  Node,
  NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RendererUtils,
  RenderTarget,
  Vector2,
} from "three/webgpu";
import {
  Fn,
  float,
  getScreenPosition,
  getViewPosition,
  max,
  min,
  mix,
  normalize,
  passTexture,
  screenUV,
  texture,
  uniform,
  vec2,
  vec4,
} from "three/tsl";

// Far off, the march's steps are hundreds of metres long, so how much cloud a
// pixel finds depends on just where its few samples land. As the view moves
// they slide through the cloud and distant cloud boils. Here the march starts
// at a new offset each frame, and each frame is blended into those before,
// followed across the screen as the camera turns: each pixel averages many
// offsets.

/** Weight of the newest frame. Lower is smoother, and slower to settle. */
const BLEND = 0.1;

/**
 * The march's offsets step by the golden ratio, so any run of frames covers
 * the step evenly.
 */
const GOLDEN = 0.6180339887;

/** What's nearer than this reprojects as though it were this far, m. */
const NEAREST = 10;
const FARTHEST = 60000;

let rendererState: any;

class CloudHistoryNode extends Node {
  private current = new RenderTarget(1, 1, {
    depthBuffer: false,
    type: HalfFloatType,
  });

  private previous = new RenderTarget(1, 1, {
    depthBuffer: false,
    type: HalfFloatType,
  });

  // SAFETY: passTexture only asks its node to build and update before it's
  // read, which any Node does; it's typed for PassNode alone.
  private output = passTexture(this as any, this.current.texture);
  private history = texture(this.previous.texture);
  private material = new NodeMaterial();
  private quad = new QuadMesh(this.material);

  private previousView = uniform(new Matrix4());
  private previousProjection = uniform(new Matrix4());
  private texel = uniform(new Vector2());
  /** 1 when there's no history to blend: the first frame, or a resize. */
  private reset = uniform(1);
  private size = new Vector2();

  constructor(
    private march: any,
    distance: any,
    private camera: Camera,
    private offset: any
  ) {
    super("vec4");
    this.updateBeforeType = NodeUpdateType.FRAME;

    const cameraPosition = uniform(camera.position);
    const cameraWorld = uniform(camera.matrixWorld);
    const projectionInverse = uniform(camera.projectionMatrixInverse);

    this.material.name = "CloudHistory";
    this.material.fragmentNode = Fn(() => {
      const fresh = march.sample(screenUV);

      // Where this pixel's cloud was last frame: along its ray, as far off
      // as the march found it. As the camera moves, near and far cloud slide
      // across the screen at different rates, so a guess at the distance
      // smears it.
      const view = getViewPosition(screenUV, float(0.5), projectionInverse);
      const direction = normalize(cameraWorld.mul(vec4(view, 0)).xyz);
      const far = distance.sample(screenUV).r.clamp(NEAREST, FARTHEST);
      const point = cameraPosition.add(direction.mul(far));

      const before = getScreenPosition(
        this.previousView.mul(vec4(point, 1)).xyz,
        this.previousProjection
      );

      // Kept within what the neighbourhood shows now, so cloud that's moved
      // or been uncovered doesn't leave a ghost.
      const low3 = fresh.toVar();
      const high3 = fresh.toVar();

      for (const [x, y] of [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
      ]) {
        const tap = march.sample(screenUV.add(vec2(x, y).mul(this.texel)));
        low3.assign(min(low3, tap));
        high3.assign(max(high3, tap));
      }

      const past = this.history.sample(before).clamp(low3, high3);

      const onScreen = before
        .greaterThanEqual(vec2(0))
        .all()
        .and(before.lessThanEqual(vec2(1)).all());

      const weight = onScreen.select(max(this.reset, BLEND), float(1));

      return mix(past, fresh, weight);
    })();
  }

  getTextureNode() {
    return this.output;
  }

  updateBefore({ renderer }: NodeFrame): undefined {
    if (!renderer) return;

    const { width, height } = this.march.value.image;

    if (width !== this.size.x || height !== this.size.y) {
      this.size.set(width, height);
      this.current.setSize(width, height);
      this.previous.setSize(width, height);
      this.texel.value.set(1 / width, 1 / height);
      this.reset.value = 1;
    }

    rendererState = RendererUtils.resetRendererState(renderer, rendererState);

    this.output.value = this.current.texture;
    this.history.value = this.previous.texture;
    renderer.setRenderTarget(this.current);
    this.quad.render(renderer);

    RendererUtils.restoreRendererState(renderer, rendererState);

    [this.current, this.previous] = [this.previous, this.current];
    this.previousView.value.copy(this.camera.matrixWorldInverse);
    this.previousProjection.value.copy(this.camera.projectionMatrix);
    this.reset.value = 0;
    this.offset.value = (this.offset.value + GOLDEN) % 1;
  }

  setup(builder) {
    // So the march renders first.
    builder.getNodeProperties(this).march = this.march;

    return this.output;
  }

  dispose() {
    super.dispose();
    this.current.dispose();
    this.previous.dispose();
    this.material.dispose();
  }
}

/**
 * The clouds' march, `march` (an rtt node), accumulated over frames: read it
 * through getTextureNode(). `distance` is the march's second output, how far
 * off each pixel's cloud is. Advances `offset` (a uniform, 0..1 of a step)
 * for the march to start at.
 */
export function cloudHistory(march, distance, camera: Camera, offset) {
  return new CloudHistoryNode(march, distance, camera, offset);
}
