import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Sprite,
  SpriteNodeMaterial,
} from "three/webgpu";
import {
  attribute,
  cameraPosition,
  exp,
  float,
  hash,
  max,
  mix,
  normalize,
  select,
  smoothstep,
  step,
  uv,
  vec3,
} from "three/tsl";
import { hazeTransmittance } from "../haze";
import { devicePixelAngle, pixelAngle } from "../landmarks/common";
import { verticalScale } from "../terrain/Terrain";
import {
  BAY,
  COOL,
  COOL_SHARE,
  LAMP_GLOW,
  STOREY,
  STREET_BUSIER,
  UNRESOLVED,
  WARM,
  WINDOW_BRIGHTNESS,
  WINDOW_GLOW,
  windowLights,
  windowShare,
} from "./material";

// Buildings as points of light, or a stack up a tall one: from a few
// kilometres a lit house is a speck anyway, and a tower a column of light.
// The buildings a tile leaves out are only these; the ones it draws fade in
// as their windows get too small to draw. Each puts out what its windows
// would, so the city's glow holds as tiles swap levels; it's spread over a
// few pixels so it doesn't crawl as the camera moves.

/** Never smaller than this many pixels across. */
const MIN_PIXELS = 2.5;

/** Glow profile exp(-FALLOFF r²) to the sprite's edge, r = 1... */
const FALLOFF = 6;

/** ...which covers this much of the sprite's square. */
const PROFILE_AREA = (Math.PI / (4 * FALLOFF)) * (1 - Math.exp(-FALLOFF));

/**
 * Of what the windows would give out: a speck reads brighter than the same
 * light spread over a wall of windows, so they're held under to match.
 */
const BRIGHTNESS = 0.35;

/**
 * Wall a light stands for, m², eases off toward this: a tower's share in
 * one speck would flare far over the houses around it.
 */
const WALL_KNEE = 600;

/** Floats per light: x, ground, z, height, seed, wall, top, drawn. */
const STRIDE = 8;

/** A tile's lights, from their decoded floats. */
export function createLights(data: Float32Array, material: SpriteNodeMaterial) {
  // Its own sprite quad, not the shared one: it's disposed with the tile.
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const corners = new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]);

  geometry.setAttribute("position", new BufferAttribute(corners, 3));
  geometry.setAttribute(
    "uv",
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)
  );
  const buffer = new InstancedInterleavedBuffer(data, STRIDE);
  geometry.setAttribute("light", new InterleavedBufferAttribute(buffer, 4, 0));
  geometry.setAttribute(
    "lightInfo",
    new InterleavedBufferAttribute(buffer, 4, 4)
  );

  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.count = data.length / STRIDE;
  sprite.frustumCulled = false;
  sprite.renderOrder = 5;

  return sprite;
}

export function createLightsMaterial() {
  const light = attribute("light", "vec4");
  const info = attribute("lightInfo", "vec4");
  const [seed, wall, top, drawn] = [info.x, info.y, info.z, info.w];

  const material = new SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  // Haze dims them; its glow is the fog's to add, and additive light can't
  // be fogged toward a colour.
  material.fog = false;

  const position = vec3(
    light.x,
    light.y.mul(verticalScale).add(light.w),
    light.z
  );

  // What the building's windows would give out toward the camera: walls
  // seen side on average a perimeter times their height over pi, less as the
  // view steepens.
  const toCamera = cameraPosition.sub(position);
  const distance = toCamera.length();
  const level = normalize(toCamera).xz.length();
  const storeys = max(top.div(STOREY), 1);

  const share = windowShare(
    seed,
    float(STREET_BUSIER - 1)
      .div(storeys)
      .add(1)
  );

  const windowless = step(32767.5, seed);
  const lamps = wall.div(max(top, 1)).mul(STOREY).mul(LAMP_GLOW);

  const glow = select(
    windowless.greaterThan(0.5),
    lamps,
    wall.div(wall.div(WALL_KNEE).add(1)).mul(WINDOW_GLOW).mul(share)
  )
    .mul(level)
    .div(Math.PI)
    // Which windows face the camera, and how many are lit, is luck.
    .mul(mix(0.4, 1.6, hash(seed.add(31337))))
    .mul(BRIGHTNESS)
    // A drawn building's windows give way to its lights as they shrink
    // under a pixel, by the material's measure (face on, bays across).
    .mul(
      mix(
        float(1),
        smoothstep(
          UNRESOLVED[0],
          UNRESOLVED[1],
          distance.mul(devicePixelAngle).div(BAY)
        ),
        drawn
      )
    );

  const colour = mix(WARM, COOL, step(1 - COOL_SHARE, hash(seed.add(271))));

  const size = distance.mul(pixelAngle).mul(MIN_PIXELS);
  // Dark buildings collapse to nothing rather than drawing black.
  material.scaleNode = size.mul(step(1e-4, glow));
  // A little toward the camera, clear of the roof and the ground.
  material.positionNode = position.add(normalize(toCamera).mul(size.mul(0.5)));

  const r = uv().sub(0.5).length().mul(2);

  const profile = exp(r.mul(r).mul(-FALLOFF)).mul(
    float(1).sub(smoothstep(0.9, 1, r))
  );

  material.colorNode = colour
    .mul(glow.div(size.mul(size).mul(PROFILE_AREA)))
    .mul(profile)
    .mul(windowLights)
    .mul(WINDOW_BRIGHTNESS)
    .mul(hazeTransmittance(cameraPosition, position));

  return material;
}
