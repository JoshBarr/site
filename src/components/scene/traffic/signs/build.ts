import {
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  SRGBColorSpace,
} from "three/webgpu";
import { attribute, select, texture, uniform, uv, vec2, vec3 } from "three/tsl";
import { parseMessage } from "../../../../lib/signs";
import { DOTS_HIGH, DOTS_WIDE, litDots, litLane } from "./dots";
import { BACK, buildSigns, HOUSING, LAMPS, PAINTED } from "./geometry";
import { pack, type PlacedFace, type PlacedStructure } from "./layout";
import { createLampMap, lampLight } from "./matrix";
import { GUTTER, paintDirection, paintSpeed } from "./paint";

// The signs as the scene draws them: a few meshes of steel and faces, one
// material, a sheet the fixed faces are painted into once, and a small map
// of every message sign's lamps, rewritten when what they show changes.

/** The painted faces' sheet: px across, and to a direction sign's capital height. */
const SHEET_WIDE = 2048;
const CAPITAL_PIXELS = 24;

/** A speed limit's disc in the sheet, px. */
const DISC_PIXELS = 96;

const GALVANISED = new Color(0x8b8f92);
const ALUMINIUM = new Color(0x6f7376);
const HOUSED = new Color(0x0b0b0c);

/**
 * How much of its own colour a painted face gives back at night, as
 * headlights find its reflective sheeting.
 */
const REFLECTIVE = 0.3;

/**
 * The signs `placed`, ready to draw: `group` holds their meshes. Their
 * painted faces are blank until `paint`, and their message signs dark
 * until `show`.
 */
export function createSigns(placed: PlacedStructure[]) {
  const faces = placed.flatMap((structure) => structure.faces);

  // Lane signs are dark: housings only, neither painted nor lit.
  const painted = faces.filter(
    ({ face }) => face.kind === "speed" || face.kind === "direction"
  );

  // Message signs, and lane signs: lamps, a band of the map each.
  const lit = faces.filter(
    ({ face }) => face.kind === "vms" || face.kind === "lane"
  );

  // Room in the sheet for each painted face, with a gutter round it.
  const { slots, height } = pack(
    painted.map(({ face, width, height, capital }) =>
      face.kind === "speed"
        ? {
            width: DISC_PIXELS + GUTTER * 2,
            height: DISC_PIXELS + GUTTER * 2,
          }
        : {
            width: Math.ceil((width / capital) * CAPITAL_PIXELS) + GUTTER * 2,
            height: Math.ceil((height / capital) * CAPITAL_PIXELS) + GUTTER * 2,
          }
    ),
    SHEET_WIDE
  );

  const sheet = { width: SHEET_WIDE, height: Math.max(height, 4) };

  const slotOf = new Map(
    painted.map((face, k) => [
      face,
      {
        x: slots[k].x + GUTTER,
        y: slots[k].y + GUTTER,
        width: slots[k].width - GUTTER * 2,
        height: slots[k].height - GUTTER * 2,
      },
    ])
  );

  const canvas = document.createElement("canvas");

  canvas.width = sheet.width;
  canvas.height = sheet.height;

  const sheetMap = new CanvasTexture(canvas);

  // Top row first, as the faces' uv has it.
  sheetMap.flipY = false;
  sheetMap.colorSpace = SRGBColorSpace;
  sheetMap.anisotropy = 8;

  // Every message sign's lamps, two pages side by side, a sign to a band.
  const lamps = new Uint8Array(
    DOTS_WIDE * 2 * DOTS_HIGH * Math.max(lit.length, 1)
  );

  const lampMap = createLampMap(lamps, DOTS_WIDE * 2);

  const night = uniform(0);
  const page = uniform(0);
  const part = attribute<"float">("part", "float");
  // Not named "dot": an attribute's name is a parameter of the vertex stage
  // in WGSL, where it'd shadow the builtin and fail the compile.
  const dot = attribute<"vec3">("lamp", "vec3");

  const is = (p: number) =>
    part.greaterThan(p - 0.5).and(part.lessThan(p + 0.5));

  const paint = texture(sheetMap, uv()).rgb;

  // Where in the map its sign's band and page are.
  const shift = vec2(page.mul(DOTS_WIDE), dot.z.mul(DOTS_HIGH));

  const inGrid = dot.x
    .greaterThan(0)
    .and(dot.x.lessThan(DOTS_WIDE))
    .and(dot.y.greaterThan(0))
    .and(dot.y.lessThan(DOTS_HIGH));

  const light = lampLight(lampMap, dot.xy.add(shift), night);

  const tone = (c: Color) => vec3(c.r, c.g, c.b);
  const material = new MeshStandardNodeMaterial({ roughness: 0.75 });

  material.colorNode = select(
    is(PAINTED),
    paint,
    select(
      is(LAMPS).or(is(HOUSING)),
      tone(HOUSED),
      select(is(BACK), tone(ALUMINIUM), tone(GALVANISED))
    )
  );
  material.emissiveNode = select(
    is(PAINTED),
    paint.mul(night.mul(REFLECTIVE)),
    select(is(LAMPS).and(inGrid), light, vec3(0))
  );

  const group = new Group();

  const meshes = buildSigns(
    placed,
    slotOf,
    sheet,
    new Map(lit.map((face, k) => [face, k]))
  ).map((geometry) => {
    const mesh = new Mesh(geometry, material);

    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);

    return mesh;
  });

  return {
    group,
    meshes,
    /** How far through lighting-up it is, 0..1. */
    night,
    /** Which page two-page messages are showing: 0 or 1. */
    page,
    /**
     * Every message sign's lamps: a band DOTS_HIGH tall for each, in the
     * order they're placed, its two pages side by side.
     */
    lampMap,

    /** Paints the fixed faces into the sheet: once, off the frame. */
    paint() {
      const context = canvas.getContext("2d");

      if (!context) return;

      for (const face of painted) {
        const slot = slotOf.get(face);

        if (!slot) continue;

        if (face.face.kind === "speed") paintSpeed(context, face.face, slot);
        else if (face.face.kind === "direction")
          paintDirection(context, face.face, face.capital, slot);
      }

      sheetMap.needsUpdate = true;
    },

    /** The lane signs, for working out what each shows. */
    lanes: lit.filter(({ face }) => face.kind === "lane"),

    /**
     * Sets every sign's lamps: message signs to `messages` (NZTA's, by sign
     * id; null for none), or all to `override`; lane signs to `limits`
     * (km/h, by face; dark where there's none).
     */
    show(
      messages: Record<string, string> | null,
      override: string | null,
      limits: ReadonlyMap<PlacedFace, number | null> = new Map()
    ) {
      lamps.fill(0);
      lit.forEach((placed, k) => {
        const { face } = placed;
        let shown: Uint8Array[];

        if (face.kind === "lane") {
          const dots = litLane(limits.get(placed) ?? null);

          shown = [dots, dots];
        } else if (face.kind === "vms") {
          // The record that's showing something: an old sign's is blank.
          const message =
            override ??
            face.ids.map((id) => messages?.[id]).find((text) => text?.trim()) ??
            "";

          const pages = parseMessage(message);

          if (!pages.length) return;
          shown = [pages[0], pages[1] ?? pages[0]].map(litDots);
        } else {
          return;
        }

        for (let row = 0; row < DOTS_HIGH; row++) {
          const to = (k * DOTS_HIGH + row) * DOTS_WIDE * 2;

          shown.forEach((dots, p) => {
            lamps.set(
              dots.subarray(row * DOTS_WIDE, (row + 1) * DOTS_WIDE),
              to + p * DOTS_WIDE
            );
          });
        }
      });
      lampMap.needsUpdate = true;
    },

    dispose() {
      for (const mesh of meshes) mesh.geometry.dispose();
      group.clear();
      material.dispose();
      sheetMap.dispose();
      lampMap.dispose();
    },
  };
}
