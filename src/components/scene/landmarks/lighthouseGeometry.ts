import {
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  SphereGeometry,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Lighthouses, simply: a tapered tower, a gallery, a glazed lantern and its
// dome. The origin is on the ground at the tower's centre, y up.

/** A sector of a light, between two charted bearings. */
interface Sector {
  /**
   * Clockwise from `from` to `to`, true bearings in degrees as the light
   * list gives them: from seaward, toward the light.
   */
  from: number;
  to: number;
  colour: "white" | "red";
}

/** How a light shows, from the LINZ light list (via OpenStreetMap). */
export interface LightCharacter {
  /** Seconds lit, dark, lit, dark… through one period. */
  sequence: number[];
  /** Where it shows; dark elsewhere. */
  sectors: Sector[];
}

export interface LighthouseSpec {
  /** Ground to the gallery deck, m. */
  towerHeight: number;
  baseRadius: number;
  topRadius: number;
  /** Sides to the tower: 8 for an octagon, more for round. */
  sides: number;
  lanternRadius: number;
  /** Glazing, deck to roof, m. */
  lanternHeight: number;
  colour: string;
  /** Dome, gallery rail and glazing bars. */
  trimColour: string;
  /** None for a light no longer lit. */
  light?: LightCharacter;
}

/**
 * The first Pencarrow light (1859): a cast-iron tower 11.6 m tall on the
 * head. Dark since Baring Head took over in 1935.
 */
export const PENCARROW: LighthouseSpec = {
  towerHeight: 8,
  baseRadius: 2,
  topRadius: 1.5,
  sides: 24,
  lanternRadius: 1.3,
  lanternHeight: 2.2,
  colour: "#eceae4",
  trimColour: "#33383b",
};

/**
 * Pencarrow's lower light (1906), at the shore: a white octagonal tower about
 * 17 m tall, light 18 m above the sea. Fl(3) WR 12s, LINZ K 4006.
 */
export const PENCARROW_LOWER: LighthouseSpec = {
  towerHeight: 13.5,
  baseRadius: 1.9,
  topRadius: 1.3,
  sides: 8,
  lanternRadius: 1.2,
  lanternHeight: 2.4,
  colour: "#eceae4",
  trimColour: "#33383b",
  light: {
    sequence: [1, 2, 1, 2, 1, 5],
    sectors: [
      { from: 0.5, to: 81, colour: "white" },
      { from: 81, to: 176.5, colour: "red" },
      { from: 176.5, to: 187.5, colour: "white" },
    ],
  },
};

/**
 * Baring Head (1935): a concrete tower 12.2 m tall on the terrace above the
 * head, light 87 m above the sea. Oc W 15s, LINZ K 4004.
 */
export const BARING_HEAD: LighthouseSpec = {
  towerHeight: 8.6,
  baseRadius: 2.2,
  topRadius: 1.7,
  sides: 24,
  lanternRadius: 1.4,
  lanternHeight: 2.2,
  colour: "#eceae4",
  trimColour: "#33383b",
  light: {
    sequence: [9, 6],
    sectors: [{ from: 301, to: 169, colour: "white" }],
  },
};

/**
 * Point Halswell: a small tower, light 8 m above the sea. Fl W 3s, LINZ
 * K 4018. Its shape and colours are guesses: check against photos.
 */
export const POINT_HALSWELL: LighthouseSpec = {
  towerHeight: 6.3,
  baseRadius: 1.3,
  topRadius: 1,
  sides: 8,
  lanternRadius: 0.9,
  lanternHeight: 1.6,
  colour: "#eceae4",
  trimColour: "#33383b",
  light: {
    sequence: [0.3, 2.7],
    sectors: [{ from: 70, to: 294, colour: "white" }],
  },
};

/** The tower runs this far below the ground so slopes can't show a gap. */
const FOOTING = 2;

const DECK = 0.3;
const RAIL = 1;
const GLAZING = "#1c272c";

/** Height of the lamp above the ground, m. */
export function lampHeight(spec: LighthouseSpec) {
  return spec.towerHeight + DECK + spec.lanternHeight / 2;
}

/** Top of the dome above the ground, m. */
export function lighthouseHeight(spec: LighthouseSpec) {
  return (
    spec.towerHeight + DECK + spec.lanternHeight + spec.lanternRadius + 0.5
  );
}

/** Radius of the tower at a height above the ground, m. */
export function lighthouseRadius(spec: LighthouseSpec, height: number) {
  const t = Math.min(Math.max(height / spec.towerHeight, 0), 1);

  return spec.baseRadius + (spec.topRadius - spec.baseRadius) * t;
}

/**
 * A part in one colour, its base `y` above the ground. `glazing` marks the
 * lantern's glass, 1, which a lit light shines through.
 */
function part(
  geometry: BufferGeometry,
  colour: string,
  y: number,
  glazing = 0
) {
  geometry.deleteAttribute("uv");
  const { r, g, b } = new Color(colour);
  const count = geometry.getAttribute("position").count;
  const colours = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) colours.set([r, g, b], i * 3);

  geometry.setAttribute("color", new Float32BufferAttribute(colours, 3));
  geometry.setAttribute(
    "glazing",
    new Float32BufferAttribute(new Float32Array(count).fill(glazing), 1)
  );

  return geometry.translate(0, y, 0);
}

/** A cylinder whose base sits at the origin. */
function cylinder(
  top: number,
  bottom: number,
  height: number,
  sides: number,
  open = false
) {
  return new CylinderGeometry(top, bottom, height, sides, 1, open).translate(
    0,
    height / 2,
    0
  );
}

export function createLighthouseGeometry(spec: LighthouseSpec) {
  const deck = spec.topRadius + 0.6;
  const lantern = spec.towerHeight + DECK;
  const roof = lantern + spec.lanternHeight;

  return mergeGeometries([
    part(
      cylinder(
        spec.topRadius,
        spec.baseRadius,
        spec.towerHeight + FOOTING,
        spec.sides
      ),
      spec.colour,
      -FOOTING
    ),
    part(cylinder(deck, deck, DECK, spec.sides), spec.colour, spec.towerHeight),
    part(
      cylinder(deck, deck, RAIL, spec.sides, true),
      spec.trimColour,
      lantern
    ),
    part(
      cylinder(spec.lanternRadius, spec.lanternRadius, spec.lanternHeight, 12),
      GLAZING,
      lantern,
      1
    ),
    part(
      new SphereGeometry(
        spec.lanternRadius + 0.1,
        16,
        6,
        0,
        Math.PI * 2,
        0,
        Math.PI / 2
      ),
      spec.trimColour,
      roof
    ),
    part(
      new SphereGeometry(0.25, 8, 6),
      spec.trimColour,
      roof + spec.lanternRadius + 0.2
    ),
  ]);
}
