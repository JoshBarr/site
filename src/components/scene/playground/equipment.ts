import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Curve,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { EQUIPMENT, groundAt, type Point } from "./layout";

// The playground's equipment, simply, as one mesh: in metres from the anchor
// (x east, y up, z south), each piece standing on the DEM's ground times the
// terrain's vertical scale, at its true size. Each vertex carries its real
// colour as `tint`. Sizes and colours are by eye from photos.

const COLOURS = {
  white: "#f1f0ea",
  glass: "#2b3438",
  window: "#3f8fd2",
  lantern: "#7c8589",
  iron: "#262b2e",
  teal: "#1f9e9a",
  yellow: "#f2b51c",
  steel: "#a9b0b4",
  post: "#6f777b",
  rope: "#d8ad3a",
  hoop: "#8f989d",
  rubber: "#2d2f31",
  timber: "#9a7b55",
  grey: "#9b978d",
  sail: "#e6e1cf",
  hull: "#b5552d",
  carving: "#7a3a22",
  thwart: "#c89a63",
  carousel: "#4f6f8f",
} as const;

type Colour = keyof typeof COLOURS;

const UP = new Vector3(0, 1, 0);

/** Collects parts in their colours; merged into one geometry at the end. */
class Kit {
  private parts: BufferGeometry[] = [];

  add(geometry: BufferGeometry, colour: Colour) {
    // Only what every part shares can be merged.
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== "position" && name !== "normal") {
        geometry.deleteAttribute(name);
      }
    }

    const part = geometry.index ? geometry.toNonIndexed() : geometry;
    const { r, g, b } = new Color(COLOURS[colour]);
    const count = part.getAttribute("position").count;
    const tint = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) tint.set([r, g, b], i * 3);

    part.setAttribute("tint", new Float32BufferAttribute(tint, 3));
    this.parts.push(part);

    return this;
  }

  /** A square-section member from a to b, `width` thick. */
  member(a: Vector3, b: Vector3, width: number, colour: Colour, depth = width) {
    const direction = new Vector3().subVectors(b, a);
    const length = direction.length();

    if (length < 1e-6) return this;

    const box = new BoxGeometry(width, length, depth);
    box.applyQuaternion(
      new Quaternion().setFromUnitVectors(UP, direction.normalize())
    );
    box.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);

    return this.add(box, colour);
  }

  /** A box `size` (x, y, z) with its base centre at `at`, turned `yaw`. */
  box(at: Vector3, size: [number, number, number], colour: Colour, yaw = 0) {
    const box = new BoxGeometry(...size).translate(0, size[1] / 2, 0);
    box.rotateY(yaw);
    box.translate(at.x, at.y, at.z);

    return this.add(box, colour);
  }

  /** A round post from `at` up `height`. */
  post(at: Vector3, height: number, radius: number, colour: Colour) {
    const post = new CylinderGeometry(radius, radius, height, 8);
    post.translate(at.x, at.y + height / 2, at.z);

    return this.add(post, colour);
  }

  /**
   * A shape swept along a smooth curve through `points`: `profile(t)` gives
   * its cross-section at t (0..1 along), as [across, up] pairs.
   */
  sweep(
    points: Vector3[],
    profile: (t: number) => [number, number][],
    colour: Colour,
    segments = 32
  ) {
    const curve = new CatmullRomCurve3(points);

    return this.along(curve, [0, 1], profile, colour, segments);
  }

  /**
   * A shape swept along `curve` between two shares of its length:
   * `profile(t)` gives its cross-section at t (0..1 over that stretch), as
   * [across, up] pairs.
   */
  along(
    curve: Curve<Vector3>,
    [from, to]: [number, number],
    profile: (t: number) => [number, number][],
    colour: Colour,
    segments = 32
  ) {
    const position: number[] = [];
    const index: number[] = [];
    let width = 0;

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const u = from + (to - from) * t;
      const at = curve.getPointAt(u);
      const ahead = curve.getTangentAt(u);
      const across = new Vector3().crossVectors(ahead, UP).normalize();
      const up = new Vector3().crossVectors(across, ahead).normalize();
      const section = profile(t);
      width = section.length;

      for (const [x, y] of section) {
        const p = at.clone().addScaledVector(across, x).addScaledVector(up, y);
        position.push(p.x, p.y, p.z);
      }
    }

    for (let i = 0; i < segments; i++) {
      for (let k = 0; k < width - 1; k++) {
        const a = i * width + k;
        const b = a + width;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();

    return this.add(geometry, colour);
  }

  /** `geometry` turned from pointing along `from` to along `to`, set `at`. */
  aim(
    geometry: BufferGeometry,
    from: Vector3,
    to: Vector3,
    at: Vector3,
    colour: Colour
  ) {
    geometry.applyQuaternion(
      new Quaternion().setFromUnitVectors(from, to.clone().normalize())
    );

    return this.add(geometry.translate(at.x, at.y, at.z), colour);
  }

  geometry() {
    const merged = mergeGeometries(this.parts);
    this.parts.forEach((part) => part.dispose());

    return merged;
  }
}

/** Compass degrees to a turn about +y in the x-east, z-south frame. */
const yawOf = (bearing: number) => Math.PI / 2 - (bearing * Math.PI) / 180;

/** A point `height` m over the ground at (east, north). */
type Place = (east: number, north: number, height: number) => Vector3;

/** Ground to the top of the gull on the lighthouse's dome, m. */
export const LIGHTHOUSE_HEIGHT = 9;

/** An octagon's corners are this many times further out than its faces. */
const CORNER = 1 / Math.cos(Math.PI / 8);

/** A closed circle of `radius`, as a sweep's cross-section. */
const ring = (radius: number, sides = 8) =>
  Array.from({ length: sides + 1 }, (_, k): [number, number] => {
    const a = (k / sides) * Math.PI * 2;

    return [radius * Math.cos(a), radius * Math.sin(a)];
  });

// The lighthouse, by eye from photos: octagonal throughout, its faces to the
// compass points. A weatherboard base with portholes, a railed deck on
// struts, a tapering weatherboard tower braced on one face, a lattice
// lantern, and for a dome a teal kina, spotted and spined, a gull on top.

/** Ground to the deck's floor, and to the top of the tower, m. */
const DECK = 2.8;
const TOWER = 6;

function lighthouse(kit: Kit, place: Place) {
  const [e, n] = EQUIPMENT.lighthouse;
  const base = place(e, n, 0);

  /** `distance` m out on compass `bearing`, `height` m up. */
  const out = (bearing: number, distance: number, height: number) => {
    const b = (bearing * Math.PI) / 180;

    return new Vector3(
      base.x + distance * Math.sin(b),
      base.y + height,
      base.z - distance * Math.cos(b)
    );
  };

  /** An octagon from `y` up `height`, `bottom` m to its faces at its foot. */
  const octagon = (
    bottom: number,
    top: number,
    y: number,
    height: number,
    colour: Colour,
    open = false
  ) =>
    kit.add(
      new CylinderGeometry(top * CORNER, bottom * CORNER, height, 8, 1, open)
        .rotateY(Math.PI / 8)
        .translate(base.x, base.y + y + height / 2, base.z),
      colour
    );

  /** Lapped weatherboards from `from` to `to`, `apothem(y)` m out. */
  const boards = (from: number, to: number, apothem: (y: number) => number) => {
    const count = Math.round((to - from) / 0.2);
    const step = (to - from) / count;

    for (let i = 0; i < count; i++) {
      const y = from + i * step;
      octagon(apothem(y) + 0.02, apothem(y + step), y, step, "white", true);
    }
  };

  const BASE = 1.6;
  const tower = (y: number) => 1.35 - (0.2 * (y - DECK)) / (TOWER - DECK);
  boards(-0.2, DECK, () => BASE);
  boards(DECK, TOWER, tower);

  /** A blue-rimmed oval window on the face at `bearing`. */
  const porthole = (
    bearing: number,
    apothem: number,
    y: number,
    width: number,
    height: number
  ) => {
    const facing = Math.PI - (bearing * Math.PI) / 180;

    for (const [inset, depth, colour] of [
      [0, 0.06, "window"],
      [0.16, 0.09, "glass"],
    ] as const) {
      const pane = new CylinderGeometry(0.5, 0.5, depth, 20)
        .rotateX(Math.PI / 2)
        .scale(width - inset, height - inset, 1)
        .rotateY(facing);

      const at = out(bearing, apothem + 0.02, y);
      kit.add(pane.translate(at.x, at.y, at.z), colour);
    }
  };

  for (const bearing of [0, 90, 180, 270]) {
    porthole(bearing, BASE, 1.35, 0.5, 0.95);
  }

  for (const bearing of [180, 270]) {
    porthole(bearing, tower(4.4), 4.4, 0.45, 0.8);
  }

  // The deck, overhanging the base on struts at its corners.
  const DECK_OUT = 2.3;
  octagon(DECK_OUT, DECK_OUT, DECK - 0.2, 0.2, "white");

  for (let k = 0; k < 8; k++) {
    const corner = 22.5 + k * 45;
    kit.member(
      out(corner, BASE * CORNER, DECK - 1),
      out(corner, (DECK_OUT - 0.1) * CORNER, DECK - 0.2),
      0.1,
      "white"
    );
  }

  // Its rail: corner posts, top and bottom rails, close-set balusters, and
  // a gap on the north-west face where the steel slide leaves.
  const RAIL = DECK_OUT - 0.08;
  const SLIDE_FACE = 7;

  for (let k = 0; k < 8; k++) {
    const left = out(k * 45 - 22.5, RAIL * CORNER, DECK);
    const right = out(k * 45 + 22.5, RAIL * CORNER, DECK);
    const width = left.distanceTo(right);
    const lift = (p: Vector3, y: number) => p.clone().setY(p.y + y);

    kit.member(left, lift(left, 1.05), 0.09, "white");
    kit.member(lift(left, 1), lift(right, 1), 0.1, "white", 0.06);
    kit.member(lift(left, 0.08), lift(right, 0.08), 0.06, "white");

    const count = Math.round(width / 0.12);

    for (let i = 1; i < count; i++) {
      if (k === SLIDE_FACE && Math.abs(i / count - 0.5) < 0.27) continue;

      const p = left.clone().lerp(right, i / count);
      kit.member(lift(p, 0.08), lift(p, 1), 0.04, "white");
    }
  }

  // The tower's north-east face is braced: a frame proud of the boards with
  // a cross in each of its two panels.
  const brace = (bearing: number, y: number) =>
    out(bearing, (tower(y) + 0.05) * CORNER, y);

  const levels = [DECK + 0.1, (DECK + TOWER) / 2, TOWER - 0.1];

  for (const bearing of [22.5, 67.5]) {
    kit.member(brace(bearing, DECK), brace(bearing, TOWER), 0.1, "white");
  }

  levels.forEach((y, i) => {
    kit.member(brace(22.5, y), brace(67.5, y), 0.1, "white");

    if (i === 0) return;

    const below = levels[i - 1];
    kit.member(brace(22.5, below), brace(67.5, y), 0.07, "white");
    kit.member(brace(67.5, below), brace(22.5, y), 0.07, "white");
  });

  // A white cap, then the lantern: grey glazing behind iron corner posts,
  // a cross and a mullion on each face, and an iron ring over it.
  octagon(1.45, 1.45, TOWER, 0.15, "white");
  const LANTERN = TOWER + 0.15;
  const GLAZED = 0.9;
  octagon(1.3, 1.3, LANTERN, GLAZED, "lantern", true);

  for (let k = 0; k < 8; k++) {
    const a = k * 45 - 22.5;
    const b = k * 45 + 22.5;
    const top = LANTERN + GLAZED;
    const r = 1.33 * CORNER;

    kit.member(out(a, r, LANTERN), out(a, r, top), 0.08, "iron");
    kit.member(out(a, r, LANTERN), out(b, r, top), 0.045, "iron");
    kit.member(out(b, r, LANTERN), out(a, r, top), 0.045, "iron");
    kit.member(
      out(k * 45, 1.33, LANTERN),
      out(k * 45, 1.33, top),
      0.04,
      "iron"
    );
  }

  octagon(1.5, 1.5, LANTERN + GLAZED, 0.15, "iron");

  // The kina: a squat teal dome, white-rimmed, spotted in rows.
  const DOME = LANTERN + GLAZED + 0.15;
  const RADIUS = 1.6;
  const SQUASH = 0.7;
  const crown = DOME + RADIUS * SQUASH;
  const centre = new Vector3(base.x, base.y + DOME, base.z);

  kit.add(
    new SphereGeometry(RADIUS, 32, 10, 0, Math.PI * 2, 0, Math.PI / 2)
      .scale(1, SQUASH, 1)
      .translate(centre.x, centre.y, centre.z),
    "teal"
  );
  kit.add(
    new TorusGeometry(RADIUS, 0.07, 6, 40)
      .rotateX(Math.PI / 2)
      .translate(centre.x, centre.y, centre.z),
    "white"
  );

  const SPOTS: [rise: number, count: number, size: number][] = [
    [0.3, 14, 0.17],
    [0.7, 10, 0.15],
    [1.08, 6, 0.12],
  ];

  SPOTS.forEach(([rise, count, size], row) => {
    for (let k = 0; k < count; k++) {
      const b = ((k + row / 2) / count) * Math.PI * 2;

      const local = new Vector3(
        Math.sin(b) * Math.cos(rise) * RADIUS,
        Math.sin(rise) * RADIUS * SQUASH,
        -Math.cos(b) * Math.cos(rise) * RADIUS
      );

      const normal = new Vector3(
        local.x,
        local.y / SQUASH ** 2,
        local.z
      ).normalize();

      kit.aim(
        new CircleGeometry(size, 10),
        new Vector3(0, 0, 1),
        normal,
        local.add(centre).addScaledVector(normal, 0.012),
        "white"
      );
    }
  });

  // Its spines: long and short in turn round the rim, curling up, and a
  // tuft of short ones round the top.
  const spine = (points: Vector3[], thick: number) =>
    kit.sweep(points, (t) => ring(thick * (1 - t) + 0.008), "white", 8);

  for (let k = 0; k < 18; k++) {
    const bearing = (k / 18) * 360 + 10;
    const length = k % 2 === 0 ? 0.85 : 0.5;

    spine(
      [
        out(bearing, RADIUS - 0.1, DOME + 0.05),
        out(bearing, RADIUS + length * 0.55, DOME + length * 0.12),
        out(bearing, RADIUS + length * 0.95, DOME + length * 0.45),
      ],
      k % 2 === 0 ? 0.13 : 0.09
    );
  }

  for (let k = 0; k < 6; k++) {
    const bearing = k * 60 + 30;

    spine(
      [
        out(bearing, 0.2, crown - 0.05),
        out(bearing, 0.42, crown + 0.2),
        out(bearing, 0.5, crown + 0.38),
      ],
      0.07
    );
  }

  // A gull on a stalk, wings out, facing north.
  const GULL = crown + 0.5;
  kit.post(out(0, 0, crown - 0.1), GULL - crown, 0.03, "iron");

  const gull = (x: number, y: number, z: number) =>
    out(0, 0, GULL).add(new Vector3(x, y, z));

  kit.add(
    new SphereGeometry(0.1, 8, 6)
      .scale(1, 1, 2.8)
      .translate(...gull(0, 0, 0).toArray()),
    "white"
  );
  kit.add(
    new SphereGeometry(0.07, 8, 6).translate(...gull(0, 0.05, -0.27).toArray()),
    "white"
  );
  kit.member(gull(0, 0, 0.15), gull(0, -0.02, 0.4), 0.14, "white", 0.02);

  for (const s of [-1, 1]) {
    kit.member(
      gull(s * 0.05, 0.02, 0),
      gull(s * 0.45, 0.17, 0.03),
      0.025,
      "white",
      0.24
    );
    kit.member(
      gull(s * 0.45, 0.17, 0.03),
      gull(s * 0.82, 0.12, 0.1),
      0.02,
      "white",
      0.16
    );
  }
}

/**
 * An open chute: a half-round of `radius`, lipped, its bottom kept level
 * with the tube's as it flares by `flare` to its mouth.
 */
const chute =
  (radius: number, flare: number) =>
  (t: number): [number, number][] => {
    const r = radius * (1 + flare * t * t);
    const lift = r - radius;
    const section: [number, number][] = [[-r - 0.12, 0.06 + lift]];

    for (let k = 0; k <= 10; k++) {
      const a = Math.PI * (k / 10);
      section.push([-r * Math.cos(a), lift - r * Math.sin(a)]);
    }

    section.push([r + 0.12, 0.06 + lift]);

    return section;
  };

/**
 * A tube slide down `curve`: a tube of `radius`, ribbed every `every` m at
 * its joints, opening into a chute for its last `open` m.
 */
function tubeSlide(
  kit: Kit,
  curve: Curve<Vector3>,
  radius: number,
  colour: Colour,
  open: number,
  every: number
) {
  const length = curve.getLength();
  const mouth = 1 - open / length;
  const ALONG = new Vector3(0, 0, 1);

  kit.along(
    curve,
    [0, mouth],
    () => ring(radius, 14),
    colour,
    Math.ceil(length * 6)
  );
  kit.along(curve, [mouth, 1], chute(radius, 0.35), colour, 12);

  for (let d = every; d < length - open; d += every) {
    const u = d / length;

    kit.aim(
      new TorusGeometry(radius + 0.02, 0.03, 4, 16),
      ALONG,
      curve.getTangentAt(u),
      curve.getPointAt(u),
      colour
    );
  }
}

/** The share of `curve`'s length at which it passes nearest `point`. */
function nearest(curve: Curve<Vector3>, point: Vector3) {
  let best = 0;
  let closest = Infinity;

  for (let i = 0; i <= 400; i++) {
    const distance = curve.getPointAt(i / 400).distanceTo(point);

    if (distance < closest) {
      closest = distance;
      best = i / 400;
    }
  }

  return best;
}

function slides(kit: Kit, place: Place) {
  const [e, n] = EQUIPMENT.lighthouse;
  // Both leave the lighthouse, so measure their heights from its foot.
  const foot = place(e, n, 0).y;

  const at = (pe: number, pn: number, height: number) => {
    const p = place(pe, pn, 0);

    return new Vector3(p.x, foot + height, p.z);
  };

  const leg = (point: Vector3, radius: number) =>
    kit.member(
      place(point.x, -point.z, -0.2),
      point.clone().setY(point.y - radius),
      0.1,
      "white"
    );

  // The yellow tube: out of the tower, once round the helix clockwise from
  // its west side and on a twelfth more, to leave it heading for the chute.
  const { start, helix, end } = EQUIPMENT.tubeSlide;
  const TURN = 390;

  const coil = Array.from({ length: 14 }, (_, i) => {
    const turned = (i / 13) * TURN;
    const b = ((270 + turned) * Math.PI) / 180;

    return at(
      helix.at[0] + helix.radius * Math.sin(b),
      helix.at[1] + helix.radius * Math.cos(b),
      helix.from + ((helix.to - helix.from) * turned) / TURN
    );
  });

  // Then straight down, easing level into the chute.
  const leaves = coil[coil.length - 1];
  const mouth = at(...end);
  const run = [0.35, 0.7, 0.88].map((f) => leaves.clone().lerp(mouth, f));
  run[2].y = mouth.y + 0.17;

  const yellow = new CatmullRomCurve3(
    [at(...start), ...coil, ...run, mouth],
    false,
    "centripetal"
  );

  tubeSlide(kit, yellow, 0.45, "yellow", 1.4, 0.7);

  // Big flanges where it leaves the tower and where it leaves the coil.
  for (const u of [0.4 / yellow.getLength(), nearest(yellow, leaves)]) {
    kit.aim(
      new CylinderGeometry(0.75, 0.75, 0.05, 24),
      UP,
      yellow.getTangentAt(u),
      yellow.getPointAt(u),
      "yellow"
    );
  }

  for (const point of [coil[3], leaves, run[0], run[1]]) leg(point, 0.45);

  // The steel tube off the deck.
  const steel = new CatmullRomCurve3(
    EQUIPMENT.steelSlide.map((spot) => at(...spot)),
    false,
    "centripetal"
  );

  tubeSlide(kit, steel, 0.4, "steel", 1.2, 0.9);
  leg(steel.getPointAt(0.5), 0.4);
}

/** An A-frame swing beam from a to b, `height` m up, on splayed legs. */
function swingFrame(
  kit: Kit,
  place: Place,
  [a, b]: [Point, Point],
  height: number
) {
  const ground = Math.min(place(...a, 0).y, place(...b, 0).y);

  const top = (p: Point) => {
    const at = place(...p, 0);

    return new Vector3(at.x, ground + height, at.z);
  };

  const ta = top(a);
  const tb = top(b);
  kit.member(ta, tb, 0.12, "post");

  // Legs splayed square to the beam.
  const along = new Vector3().subVectors(tb, ta).normalize();
  const side = new Vector3().crossVectors(along, UP).normalize();

  for (const end of [ta, tb]) {
    for (const s of [-1, 1]) {
      const foot = end.clone().addScaledVector(side, s * 1.1);
      foot.y = place(foot.x, -foot.z, -0.2).y;
      kit.member(end, foot, 0.09, "post");
    }
  }

  return { ta, tb, along, side };
}

function swings(kit: Kit, place: Place) {
  const frame = swingFrame(kit, place, EQUIPMENT.swings, 2.5);
  const length = frame.ta.distanceTo(frame.tb);

  // A middle A-frame, then two seats a bay.
  const middle = frame.ta.clone().lerp(frame.tb, 0.5);

  for (const s of [-1, 1]) {
    const foot = middle.clone().addScaledVector(frame.side, s * 1.1);
    foot.y = place(foot.x, -foot.z, -0.2).y;
    kit.member(middle, foot, 0.09, "post");
  }

  for (const d of [0.22, 0.38, 0.62, 0.78]) {
    const hang = frame.ta.clone().addScaledVector(frame.along, length * d);
    const seat = place(hang.x, -hang.z, 0.45);

    for (const s of [-0.2, 0.2]) {
      const top = hang.clone().addScaledVector(frame.along, s);
      const bottom = seat.clone().addScaledVector(frame.along, s);
      kit.member(top, bottom, 0.025, "post");
    }

    kit.box(
      seat.clone().setY(seat.y - 0.03),
      [0.5, 0.05, 0.2],
      "rubber",
      Math.atan2(-frame.along.z, frame.along.x)
    );
  }
}

function nestSwing(kit: Kit, place: Place) {
  const frame = swingFrame(kit, place, EQUIPMENT.nestSwing, 2.6);
  const middle = frame.ta.clone().lerp(frame.tb, 0.5);
  const nest = place(middle.x, -middle.z, 0.55);

  kit.add(
    new TorusGeometry(0.55, 0.06, 6, 20)
      .rotateX(Math.PI / 2)
      .translate(nest.x, nest.y, nest.z),
    "rubber"
  );
  kit.add(
    new CylinderGeometry(0.52, 0.52, 0.03, 16).translate(
      nest.x,
      nest.y,
      nest.z
    ),
    "rubber"
  );

  // Ropes from the beam, two either side of the middle, to the rim.
  for (const [s, r] of [
    [-0.35, -1],
    [0.35, 1],
  ]) {
    const top = middle.clone().addScaledVector(frame.along, s);

    for (const t of [-1, 1]) {
      const rim = nest
        .clone()
        .addScaledVector(frame.along, r * 0.4)
        .addScaledVector(frame.side, t * 0.38);

      kit.member(top, rim, 0.03, "post");
    }
  }
}

function sail(kit: Kit, place: Place) {
  const corners = EQUIPMENT.sail.map(([e, n, h]) => place(e, n, h));

  // Masts, a little taller than the corners they hold.
  EQUIPMENT.sail.forEach(([e, n, h]) => {
    kit.post(place(e, n, -0.3), h + 0.6, 0.08, "post");
  });

  // The sail: a bilinear patch between its corners, its edges drawn in.
  const [a, b, c, d] = corners;
  const centre = new Vector3().add(a).add(b).add(c).add(d).multiplyScalar(0.25);
  const steps = 12;
  const position: number[] = [];
  const index: number[] = [];

  for (let j = 0; j <= steps; j++) {
    const v = j / steps;

    for (let i = 0; i <= steps; i++) {
      const u = i / steps;

      const p = new Vector3()
        .addScaledVector(a, (1 - u) * (1 - v))
        .addScaledVector(b, u * (1 - v))
        .addScaledVector(c, u * v)
        .addScaledVector(d, (1 - u) * v);

      const su = Math.sin(Math.PI * u);
      const sv = Math.sin(Math.PI * v);
      const pull = 0.14 * (su * (1 - sv) + sv * (1 - su));
      p.lerp(centre, pull);
      position.push(p.x, p.y, p.z);
    }
  }

  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const k = j * (steps + 1) + i;
      index.push(k, k + 1, k + steps + 1, k + 1, k + steps + 2, k + steps + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  kit.add(geometry, "sail");
}

function carousel(kit: Kit, place: Place) {
  const at = place(...EQUIPMENT.carousel, 0);
  kit.add(
    new CylinderGeometry(1.6, 1.6, 0.2, 24).translate(at.x, at.y + 0.1, at.z),
    "carousel"
  );
  kit.post(at, 1.05, 0.08, "post");
  kit.add(
    new TorusGeometry(1.25, 0.035, 6, 32)
      .rotateX(Math.PI / 2)
      .translate(at.x, at.y + 0.9, at.z),
    "yellow"
  );

  // Spokes out to the rail.
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;

    const rim = at
      .clone()
      .add(new Vector3(Math.cos(a) * 1.25, 0.9, Math.sin(a) * 1.25));

    kit.member(at.clone().setY(at.y + 0.2), rim, 0.04, "yellow");
  }
}

function fishnet(kit: Kit, place: Place) {
  const hoops = EQUIPMENT.fishnet;
  const first = hoops[0].at;
  const last = hoops[hoops.length - 1].at;
  const spine = new Vector3(last[0] - first[0], 0, -(last[1] - first[1]));
  spine.normalize();
  const side = new Vector3().crossVectors(spine, UP).normalize();
  const turn = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), spine);

  // Each hoop's centre is sunk to this share of its radius.
  const SINK = 0.5;
  const ground = Math.min(...hoops.map(({ at }) => place(...at, 0).y));

  const centres = hoops.map(({ at, radius }) => {
    const p = place(...at, 0);

    return new Vector3(p.x, ground + radius * SINK, p.z);
  });

  hoops.forEach(({ radius }, i) => {
    kit.add(
      new TorusGeometry(radius, 0.07, 6, 40)
        .applyQuaternion(turn)
        .translate(centres[i].x, centres[i].y, centres[i].z),
      "hoop"
    );
  });

  // Rope net between neighbouring hoops: lines along the spine, and rings.
  const lowest = Math.asin(-SINK);
  const ROPES = 12;

  const point = (i: number, k: number) => {
    const a = lowest + ((Math.PI - 2 * lowest) * k) / ROPES;

    return centres[i]
      .clone()
      .addScaledVector(side, Math.cos(a) * hoops[i].radius)
      .addScaledVector(UP, Math.sin(a) * hoops[i].radius);
  };

  for (let i = 0; i < hoops.length - 1; i++) {
    for (let k = 0; k <= ROPES; k++) {
      kit.member(point(i, k), point(i + 1, k), 0.045, "rope");
    }

    for (const s of [1 / 3, 2 / 3]) {
      for (let k = 0; k < ROPES; k++) {
        kit.member(
          point(i, k).lerp(point(i + 1, k), s),
          point(i, k + 1).lerp(point(i + 1, k + 1), s),
          0.045,
          "rope"
        );
      }
    }
  }
}

function waka(kit: Kit, place: Place) {
  const { bow, stern } = EQUIPMENT.waka;
  const b = place(...bow, 0);
  const s = place(...stern, 0);
  const foot = Math.min(b.y, s.y);
  b.y = foot;
  s.y = foot;
  const along = new Vector3().subVectors(s, b).normalize();
  const length = b.distanceTo(s);

  // Keel rocker, sheer and beam along the hull, t from bow to stern.
  const keel = (t: number) => 0.35 * Math.abs(2 * t - 1) ** 3;
  const gunwale = (t: number) => 0.75 + 0.3 * (2 * t - 1) ** 2;

  const beam = (t: number) =>
    0.6 * Math.max(0, 1 - Math.abs(2 * t - 1) ** 2.2) ** 0.6 + 0.03;

  const hull = (t: number): [number, number][] =>
    Array.from({ length: 11 }, (_, k) => {
      const a = -Math.PI / 2 + (Math.PI * k) / 10;
      const top = gunwale(t);

      return [beam(t) * Math.sin(a), top - (top - keel(t)) * Math.cos(a)];
    });

  kit.sweep(
    Array.from({ length: 5 }, (_, i) =>
      b.clone().addScaledVector(along, (length * i) / 4)
    ),
    hull,
    "hull",
    40
  );

  // Thwarts across it.
  const yaw = Math.atan2(-along.z, along.x);

  for (let k = 1; k <= 6; k++) {
    const t = 0.15 + (0.7 * k) / 7;
    const at = b.clone().addScaledVector(along, length * t);
    at.y += gunwale(t) - 0.22;
    kit.box(at, [0.22, 0.06, beam(t) * 2 - 0.04], "thwart", yaw);
  }

  // The carved head at the bow, leaning out over it.
  const head = b.clone().addScaledVector(along, -0.25);
  head.y += 0.3;
  kit.member(
    head,
    head
      .clone()
      .addScaledVector(along, -0.5)
      .add(new Vector3(0, 0.85, 0)),
    0.5,
    "carving",
    0.7
  );
  kit.member(
    head
      .clone()
      .addScaledVector(along, -0.35)
      .add(new Vector3(0, 0.5, 0)),
    head
      .clone()
      .addScaledVector(along, -1)
      .add(new Vector3(0, 0.35, 0)),
    0.3,
    "carving",
    0.35
  );

  // The tall sternpost, raked back.
  const post = s.clone().addScaledVector(along, -0.15);
  post.y += 0.6;
  kit.member(
    post,
    post
      .clone()
      .addScaledVector(along, 0.45)
      .add(new Vector3(0, 2.2, 0)),
    0.12,
    "carving",
    0.5
  );
}

function furniture(kit: Kit, place: Place) {
  for (const [e, n, size] of EQUIPMENT.boxes) {
    kit.box(place(e, n, -0.05), [size, size + 0.05, size], "grey", 0.3);
  }

  for (const [e, n, bearing] of EQUIPMENT.tables) {
    const yaw = yawOf(bearing);
    const at = place(e, n, 0);

    const offset = (across: number) =>
      at
        .clone()
        .add(
          new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(across)
        );

    kit.box(offset(0).setY(at.y + 0.7), [1.8, 0.05, 0.75], "timber", yaw);

    for (const s of [-0.65, 0.65]) {
      kit.box(offset(s).setY(at.y + 0.43), [1.8, 0.04, 0.28], "timber", yaw);
    }

    // Legs under the top's corners and the seats' ends.
    const lengthwise = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    for (const t of [-0.75, 0.75]) {
      for (const [s, height] of [
        [-0.65, 0.43],
        [-0.3, 0.7],
        [0.3, 0.7],
        [0.65, 0.43],
      ]) {
        const leg = offset(s).addScaledVector(lengthwise, t);
        kit.box(leg, [0.07, height, 0.07], "timber", yaw);
      }
    }
  }

  for (const [e, n, bearing] of EQUIPMENT.benches) {
    // The seat runs square to the way it faces.
    const yaw = yawOf(bearing + 90);
    const at = place(e, n, 0);

    const facing = new Vector3(
      Math.sin((bearing * Math.PI) / 180),
      0,
      -Math.cos((bearing * Math.PI) / 180)
    );

    kit.box(at.clone().setY(at.y + 0.42), [1.8, 0.05, 0.42], "timber", yaw);
    kit.box(
      at
        .clone()
        .addScaledVector(facing, -0.22)
        .setY(at.y + 0.5),
      [1.8, 0.4, 0.05],
      "timber",
      yaw
    );
    kit.box(at, [1.6, 0.42, 0.3], "post", yaw);
  }

  for (const [e, n] of EQUIPMENT.lamps) {
    const at = place(e, n, -0.3);
    kit.post(at, 6.3, 0.07, "post");
    kit.box(at.clone().setY(at.y + 6.3), [0.5, 0.15, 0.25], "post");
  }
}

/**
 * Every piece of the playground in one geometry. `scale` is the terrain's
 * vertical scale, which the ground under each piece is drawn at.
 */
export function createEquipmentGeometry(scale: number) {
  const kit = new Kit();

  const place: Place = (east, north, height) =>
    new Vector3(east, groundAt(east, north) * scale + height, -north);

  lighthouse(kit, place);
  slides(kit, place);
  swings(kit, place);
  nestSwing(kit, place);
  sail(kit, place);
  carousel(kit, place);
  fishnet(kit, place);
  waka(kit, place);
  furniture(kit, place);

  return kit.geometry();
}
