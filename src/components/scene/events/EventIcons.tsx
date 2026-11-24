import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  CanvasTexture,
  InstancedBufferAttribute,
  LinearFilter,
  Sprite,
  SpriteNodeMaterial,
} from "three/webgpu";
import {
  cameraPosition,
  float,
  fwidth,
  instancedBufferAttribute,
  max,
  mix,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
} from "three/tsl";
import { type Kind, kinds, type VenueKey } from "../../../lib/events";
import { pixelAngle } from "../landmarks/common";
import { verticalScale } from "../terrain/Terrain";
import { nztmToWorld, type TileIndex } from "../terrain/manifest";
import type { VenueState } from "./schedule";
import { VENUE_SITES } from "./venues";

// An icon over each venue while something's on in it, saying what: a rugby
// ball, a piano for an orchestra, theatre masks. A white glyph on a dark
// disc, ringed, the same size on screen however far off.

// Material Symbols Rounded, weight 400, filled, from @material-symbols/svg-400
// 0.48.3 (Apache-2.0, Google), as controls/icons.tsx has them: 960 units
// square, y from -960 at the top.
const GLYPHS: Record<Kind, string> = {
  rugby:
    "M299-100q-63 0-107-12t-58-26q-15-14-24.5-57T100-301q0-115 41-222t116-185q69-77 179-114.5T667-860q62 0 106.5 10.5T831-827q14 11 21.5 52t7.5 111q0 119-39.5 226T708-257q-75 78-184 117.5T299-100ZM157-278q32-88 85-168.5T367-599q57-60 136-108.5T687-804q-106-5-212.5 34T301-664q-66 69-106.5 173T157-278Zm122 121q119-5 221.5-43.5T665-301q66-69 103.5-173.5T804-688q-43 105-92.5 181.5T599-367q-56 60-133.5 108.5T279-157Z",
  football:
    "M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480.5q0-82.5 31.5-155t86-127Q252-817 325-848.5T480-880q83 0 155.5 31.5t127 86q54.5 54.5 86 127t31.5 155q0 82.5-31.5 155.5t-86 127.5q-54.5 54.5-127 86T480-80Zm205-493 69-24 18-64q-34-53-84-90.5T575-809l-65 43v70l175 123Zm-409 0 174-123v-70l-64-43q-63 20-113 57.5T189-661l22 64 65 24Zm-54 320 60-7 39-65-62-191-71-24-48 39q0 72 16 131.5T222-253Zm312.5 108q27.5-5 57.5-13l33-72-32-55H368l-32 55 33 72q26 8 55 13t56 5q27 0 54.5-5ZM374-345h208l61-183-163-117-166 117 60 183Zm365 92q49-57 65-116.5T820-501l-48-33-70 18-62 191 38 65 61 7Z",
  cricket:
    "M579-390 479-290q-10 10-25.5 10T428-290L90-628q-10-10-10-23t10-23l100-100q10-10 25.5-13t25.5 7l338 338q10 10 10 26t-10 26Zm148 284L573-260l44-44 154 154q9 9 9 22t-9 22q-9 9-22 9t-22-9Zm-68.5-551.5Q621-695 621-750t37.5-92.5Q696-880 751-880t92.5 37.5Q881-805 881-750t-37.5 92.5Q806-620 751-620t-92.5-37.5Z",
  sport:
    "M158-723v-96q0-8 7-12.5t15-.5l95 48q8 5 8 13t-8 13l-95 48q-8 4-15-.5t-7-12.5Zm540 0v-96q0-8 7-12.5t15-.5l95 48q8 5 8 13t-8 13l-95 48q-8 4-15-.5t-7-12.5Zm-252-36v-96q0-8 7-12.5t15-.5l95 48q8 5 8 13t-8 13l-95 48q-8 4-15-.5t-7-12.5ZM345-86q-102-10-183.5-40T80-200v-360q0-25 31.5-46.5t85.5-38q54-16.5 127-26t156-9.5q83 0 156 9.5t127 26q54 16.5 85.5 38T880-560v360q0 45-82 74.5T614-86q-10 1-17-5.5t-7-16.5v-62q0-46-32-78t-78-32q-46 0-78 32t-32 78v61q0 10-7.5 17T345-86Zm135-414q97 0 172.5-14.5T800-558q-23-24-107.5-43T480-620q-128 0-212.5 19T160-558q72 29 147.5 43.5T480-500Z",
  classical:
    "M180-120q-24 0-42-18t-18-42v-600q0-23 18-41.5t42-18.5h600q23 0 41.5 18.5T840-780v600q0 24-18.5 42T780-120H180Zm0-60h157v-210h-20q-12.75 0-21.37-8.63Q287-407.25 287-420v-360H180v600Zm443 0h157v-600H673v360q0 12.75-8.62 21.37Q655.75-390 643-390h-20v210Zm-246 0h206v-210h-20q-12.75 0-21.37-8.63Q533-407.25 533-420v-360H427v360q0 12.75-8.62 21.37Q409.75-390 397-390h-20v210Z",
  music:
    "M286.5-163.5Q243-207 243-270t43.5-106.5Q330-420 393-420q28 0 50.5 8t39.5 22v-420q0-13 8.5-21.5T513-840h174q13 0 21.5 8.5T717-810v75q0 13-8.5 21.5T687-705H543v435q0 63-43.5 106.5T393-120q-63 0-106.5-43.5Z",
  theatre:
    "M275-80q-97 0-166-70.5T40-315v-207q0-24.75 17.63-42.38Q75.25-582 100-582h349q24.75 0 42.38 17.62Q509-546.75 509-522v207q0 94-68.25 164.5T275-80Zm-86-306q13.6 0 22.8-9.2 9.2-9.2 9.2-22.8 0-13.6-9.2-22.8-9.2-9.2-22.8-9.2-13.6 0-22.8 9.2-9.2 9.2-9.2 22.8 0 13.6 9.2 22.8 9.2 9.2 22.8 9.2Zm196-9.2q9-9.2 9-22.8 0-13.6-9.2-22.8-9.2-9.2-22.8-9.2-13.6 0-22.8 9.2-9.2 9.2-9.2 22.8 0 13.6 9 22.8 9 9.2 23 9.2t23-9.2ZM920-821v217q0 95-68.25 160T686-379q-23 0-44.5-3.5T599-394q-17-6-28.5-19.85Q559-427.69 559-445v-96q0-35.35-22.81-61.68Q513.39-629 478-629q-12 0-20.5-9t-8.5-21v-162q0-24.75 17.63-42.38Q484.25-881 509-881h351q24.75 0 42.38 17.62Q920-845.75 920-821ZM601-676q13.6 0 22.8-10 9.2-10 9.2-22 0-13.6-9.2-22.8-9.2-9.2-22.8-9.2-13.6 0-22.8 9.2-9.2 9.2-9.2 22.8 0 12 9.2 22t22.8 10Zm172 0q13.6 0 22.8-10 9.2-10 9.2-22 0-13.6-9.2-22.8-9.2-9.2-22.8-9.2-13.6 0-22.8 9.2-9.2 9.2-9.2 22.8 0 12 9.2 22t22.8 10Zm-142.5 85q-26.5 9-42.5 32-6 10 1 19.5t19.86 9.5h154.28q12.86 0 19.86-9.5t1-19.5q-16-23-42.5-32t-55.5-9q-29 0-55.5 9Zm-298 351q26.5-9 42.5-32 6-9.67-1-19.33-7-9.67-19.56-9.67H199.56Q187-301 180-291.33q-7 9.66-1 19.33 16 23 42.5 32t55.5 9q29 0 55.5-9Z",
  comedy:
    "M408-453.92q-29-30.91-29-75.08v-251q0-41.67 29.44-70.83Q437.88-880 479.94-880t71.56 29.17Q581-821.67 581-780v251q0 44.17-29 75.08Q523-423 480-423t-72-30.92ZM450-150v-106q-96-11-166.5-77.5T202-498q-2-12.85 6.59-21.93 8.6-9.07 21.5-9.07 12.91 0 21.41 9t10.5 22q12 81 74.71 132.5Q399.42-314 479.65-314q81.35 0 143.85-51.5T698-498q2-13 10.68-22 8.67-9 21.5-9 12.82 0 21.32 9.07 8.5 9.08 6.5 21.93-11 97-81 164t-167 78v106q0 12.75-8.68 21.37-8.67 8.63-21.5 8.63-12.82 0-21.32-8.63-8.5-8.62-8.5-21.37Z",
  film: "m140-800 58 119q8 15 22 24t31 9q32 0 49-27.5t3-56.5l-33-68h89l58 119q8 15 22 24t31 9q32 0 49-27.5t3-56.5l-33-68h89l58 119q8 15 22 24t31 9q32 0 49-27.5t3-56.5l-33-68h112q24 0 42 18t18 42v520q0 24-18 42t-42 18H140q-24 0-42-18t-18-42v-520q0-24 18-42t42-18Z",
};

/** Atlas cells, px: one glyph each, in a row in `kinds`'s order. */
const CELL = 128;

/** Icons are this many pixels across, at any distance. */
const PIXELS = 30;

/** The glyph's share of the disc. */
const GLYPH = 0.56;

/** The ring's inner edge, as a share of the radius. */
const RING = 0.84;

/** Icons sit this high over a venue's roof, m, or a roof of MIN_HEIGHT. */
const CLEARANCE = 22;
const MIN_HEIGHT = 20;

/** The glyphs, white on clear, or null where there's no 2D canvas. */
function drawGlyphs() {
  const canvas = document.createElement("canvas");
  canvas.width = CELL * kinds.length;
  canvas.height = CELL;
  const context = canvas.getContext("2d");

  if (!context) return null;

  context.fillStyle = "#fff";

  kinds.forEach((kind, i) => {
    context.setTransform(CELL / 960, 0, 0, CELL / 960, i * CELL, CELL);
    context.fill(new Path2D(GLYPHS[kind]));
  });

  const atlas = new CanvasTexture(canvas);
  atlas.minFilter = LinearFilter;
  atlas.generateMipmaps = false;

  return atlas;
}

// SAFETY: VENUE_SITES is keyed by VenueKey.
const VENUES = Object.keys(VENUE_SITES) as VenueKey[];

/** Icons over the venues, as `states` (read each frame) has them on. */
export function EventIcons({
  index,
  states,
}: {
  index: TileIndex;
  states: { current: Map<VenueKey, VenueState> };
}) {
  const { manifest } = index;

  const icons = useMemo(() => {
    const atlas = drawGlyphs();

    if (!atlas) return null;

    const positions = new Float32Array(
      VENUES.flatMap((venue) => {
        const { centre, ground, height } = VENUE_SITES[venue];
        const [x, z] = nztmToWorld(manifest, centre[0], centre[1]);

        return [
          x,
          ground * verticalScale.value +
            Math.max(height, MIN_HEIGHT) +
            CLEARANCE,
          z,
        ];
      })
    );

    // Which glyph, and how far shown (0..1), each venue's.
    const shown = new InstancedBufferAttribute(
      new Float32Array(VENUES.length * 2),
      2
    );

    const position = instancedBufferAttribute<"vec3">(
      new InstancedBufferAttribute(positions, 3),
      "vec3"
    );

    const icon = instancedBufferAttribute<"vec2">(shown, "vec2");

    const material = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
    });

    material.fog = false;
    material.positionNode = position;
    material.scaleNode = cameraPosition
      .distance(position)
      .mul(pixelAngle)
      .mul(PIXELS);

    const offset = uv().sub(0.5);
    const r = offset.length().mul(2);
    const edge = fwidth(r);
    const disc = float(1).sub(smoothstep(float(1).sub(edge), 1, r));
    const ring = smoothstep(float(RING).sub(edge), RING, r);

    const inGlyph = offset.div(GLYPH).add(0.5);

    const inside = step(0, inGlyph.x)
      .mul(step(inGlyph.x, 1))
      .mul(step(0, inGlyph.y))
      .mul(step(inGlyph.y, 1));

    const glyph = texture(
      atlas,
      vec2(icon.x.add(inGlyph.x).div(kinds.length), inGlyph.y)
    ).a.mul(inside);

    material.colorNode = mix(float(0.06), float(0.9), max(ring, glyph));
    material.opacityNode = disc.mul(icon.y).mul(0.95);

    const sprite = new Sprite(material);
    sprite.count = VENUES.length;
    sprite.frustumCulled = false;
    sprite.renderOrder = 20;

    return { sprite, shown, atlas };
  }, [manifest]);

  useEffect(
    () => () => {
      icons?.sprite.material.dispose();
      icons?.atlas.dispose();
    },
    [icons]
  );

  useFrame(() => {
    if (!icons) return;

    const { array } = icons.shown;
    let changed = false;
    let any = false;

    VENUES.forEach((venue, i) => {
      const state = states.current.get(venue);
      const cell = state ? kinds.indexOf(state.kind) : 0;
      const lit = state?.lit ?? 0;

      if (array[i * 2] !== cell || array[i * 2 + 1] !== lit) {
        array[i * 2] = cell;
        array[i * 2 + 1] = lit;
        changed = true;
      }

      any ||= lit > 0;
    });

    if (changed) icons.shown.needsUpdate = true;
    icons.sprite.visible = any;
  });

  if (!icons) return null;

  return <primitive object={icons.sprite} name="event icons" />;
}
