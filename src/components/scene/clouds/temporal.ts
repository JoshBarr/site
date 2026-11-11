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
  bool,
  float,
  getScreenPosition,
  getViewPosition,
  max,
  min,
  mix,
  normalize,
  passTexture,
  screenCoordinate,
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

// Marching every pixel every frame to keep a tenth of it is most of what the
// clouds cost. With `sub`, the march is half the size each way, and goes
// through one pixel of each 2×2 block of this history's a frame, each in
// turn: a pixel is marched every fourth frame and kept from the history in
// between. Where there's no history to keep (off screen last frame, or after
// a resize) it's the frame's coarse march, spread out.

/**
 * Weight of a pixel's own new march, a frame in four. Tried on the /clouds
 * bench against the march of every pixel: higher flickers, lower smears.
 */
const OWN_BLEND = 0.15;

/**
 * And of the coarse march around it, the three frames between: little, since
 * it's blurred, but it's what moves a pixel on between its own.
 */
const REST_BLEND = 0.04;

/** The block's pixels in the order they're marched: far apart in turn. */
const ORDER = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
];

/**
 * The march's offsets step by the golden ratio, so any run of frames covers
 * the step evenly.
 */
const GOLDEN = 0.6180339887;

/** What's nearer than this reprojects as though it were this far, m. */
const NEAREST = 10;
const FARTHEST = 60000;

let rendererState: any;

/**
 * `map` at `uv`, between its pixels along a Catmull-Rom curve rather than
 * straight lines: the history is read between pixels every frame the view
 * moves, and each straight-line read blurs it a little more. Five reads, the
 * corners of the usual nine left out; `texel` is one of its pixels, in uv.
 */
function sharp(map, uv, texel) {
  const position = uv.div(texel);
  const first = position.sub(0.5).floor().add(0.5);
  const f = position.sub(first);

  const w0 = f.mul(f.mul(f.mul(-0.5).add(1)).sub(0.5));
  const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1);
  const w2 = f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5));
  const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5));
  const w12 = w1.add(w2);

  const before = first.sub(1).mul(texel);
  const between = first.add(w2.div(w12)).mul(texel);
  const after = first.add(2).mul(texel);

  const taps: [any, any][] = [
    [vec2(between.x, before.y), w12.x.mul(w0.y)],
    [vec2(before.x, between.y), w0.x.mul(w12.y)],
    [between, w12.x.mul(w12.y)],
    [vec2(after.x, between.y), w3.x.mul(w12.y)],
    [vec2(between.x, after.y), w12.x.mul(w3.y)],
  ];

  let sum: any = vec4(0);
  let weights: any = float(0);

  for (const [at, weight] of taps) {
    sum = sum.add(map.sample(at).mul(weight));
    weights = weights.add(weight);
  }

  return sum.div(weights);
}

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
  /** One pixel of the march, in uv. */
  private texel = uniform(new Vector2());
  /** 1 when there's no history to blend: the first frame, or a resize. */
  private reset = uniform(1);
  private size = new Vector2();
  private frame = 0;

  constructor(
    private march: any,
    distance: any,
    private camera: Camera,
    private offset: any,
    private sub: any = null
  ) {
    super("vec4");
    this.updateBeforeType = NodeUpdateType.FRAME;

    const cameraPosition = uniform(camera.position);
    const cameraWorld = uniform(camera.matrixWorld);
    const projectionInverse = uniform(camera.projectionMatrixInverse);

    this.material.name = "CloudHistory";
    this.material.fragmentNode = Fn(() => {
      // The march's pixel this one's in, and whether it's the one of its
      // block marched this frame. Marching every pixel, it always is.
      const pixel = screenCoordinate.xy.floor();
      const block = sub ? pixel.div(2).floor() : pixel;
      const centre = block.add(0.5).mul(this.texel);

      const own = sub ? pixel.sub(block.mul(2)).equal(sub).all() : bool(true);

      // The march as it stands here: this pixel's own, or between those
      // around it, which each went through their block's pixel `sub`.
      const around = sub
        ? screenUV.sub(sub.sub(0.5).mul(this.texel).mul(0.5))
        : screenUV;

      const marched = march.sample(centre);
      const fresh = sub ? own.select(marched, march.sample(around)) : marched;

      // Kept within what the neighbourhood shows now, so cloud that's moved
      // or been uncovered doesn't leave a ghost.
      const low3 = marched.toVar();
      const high3 = marched.toVar();
      const nearest = distance.sample(sub ? centre : around).r.toVar();

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
        const beside = centre.add(vec2(x, y).mul(this.texel));
        const tap = march.sample(beside);
        low3.assign(min(low3, tap));
        high3.assign(max(high3, tap));

        // A quarter march's pixel may be one beside the cloud's edge, not on
        // it: the nearest cloud of those next to it, which is the edge that
        // would smear.
        if (sub && x * y === 0) {
          nearest.assign(min(nearest, distance.sample(beside).r));
        }
      }

      // Where this pixel's cloud was last frame: along its ray, as far off
      // as the march found it. As the camera moves, near and far cloud slide
      // across the screen at different rates, so a guess at the distance
      // smears it.
      const view = getViewPosition(screenUV, float(0.5), projectionInverse);
      const direction = normalize(cameraWorld.mul(vec4(view, 0)).xyz);
      const far = nearest.clamp(NEAREST, FARTHEST);
      const point = cameraPosition.add(direction.mul(far));

      const before = getScreenPosition(
        this.previousView.mul(vec4(point, 1)).xyz,
        this.previousProjection
      );

      // Read along a curve: a quarter march renews a pixel too seldom to
      // undo the blur of reading the history between pixels as it moves.
      const kept = sub
        ? sharp(this.history, before, this.texel.mul(0.5))
        : this.history.sample(before);

      const past = kept.clamp(low3, high3);

      const onScreen = before
        .greaterThanEqual(vec2(0))
        .all()
        .and(before.lessThanEqual(vec2(1)).all());

      const blend = sub
        ? own.select(float(OWN_BLEND), float(REST_BLEND))
        : float(BLEND);

      const weight = onScreen.select(max(this.reset, blend), float(1));

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
      // Each of a quarter march's pixels is four of the history's.
      const scale = this.sub ? 2 : 1;

      this.size.set(width, height);
      this.current.setSize(width * scale, height * scale);
      this.previous.setSize(width * scale, height * scale);
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

    // The march has drawn this frame's already; the next frame's pixel.
    if (this.sub) {
      this.frame = (this.frame + 1) % ORDER.length;
      this.sub.value.set(...ORDER[this.frame]);
    }
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
 * for the march to start at. With `sub` (a vec2 uniform), the march is taken
 * to be half this history's size each way and to go through one pixel of
 * each 2×2 block a frame, which it sets `sub` to.
 */
export function cloudHistory(
  march,
  distance,
  camera: Camera,
  offset,
  sub: any = null
) {
  return new CloudHistoryNode(march, distance, camera, offset, sub);
}
