import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { EQUIPMENT, groundAt, type Point } from "./layout";

// The playground's equipment, simply, as one mesh: in metres from the anchor
// (x east, y up, z south), each piece standing on the DEM's ground times the
// terrain's vertical scale, at its true size. Each vertex carries its real
// colour as `tint`. Sizes and colours are by eye from photos.

const COLOURS = {
  white: "#f1f0ea",
  frame: "#e9e7e0",
  glass: "#2b3438",
  teal: "#2f8c8a",
  yellow: "#f2b51c",
  steel: "#a9b0b4",
  post: "#6f777b",
  rope: "#d8ad3a",
  hoop: "#8f989d",
  rubber: "#2d2f31",
  deck: "#a88454",
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

  /** A round tube along a smooth curve through `points`. */
  tube(points: Vector3[], radius: number, colour: Colour, segments = 48) {
    const curve = new CatmullRomCurve3(points);

    return this.add(
      new TubeGeometry(curve, segments, radius, 10, false),
      colour
    );
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
    const position: number[] = [];
    const index: number[] = [];
    let width = 0;

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const at = curve.getPointAt(t);
      const along = curve.getTangentAt(t);
      const across = new Vector3().crossVectors(along, UP).normalize();
      const up = new Vector3().crossVectors(across, along).normalize();
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

/** Ground to the lighthouse's weathervane, m. */
export const LIGHTHOUSE_HEIGHT = 8.5;

function lighthouse(kit: Kit, place: Place) {
  const [e, n] = EQUIPMENT.lighthouse;
  const base = place(e, n, 0);

  const at = (x: number, y: number, z: number) =>
    new Vector3(base.x + x, base.y + y, base.z + z);

  // A square white frame on four posts, braced.
  const half = 1.3;
  const top = 4;

  const corners: [number, number][] = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];

  for (const [x, z] of corners) {
    kit.member(at(x, -0.3, z), at(x, top, z), 0.18, "frame");
  }

  corners.forEach(([x, z], i) => {
    const [x2, z2] = corners[(i + 1) % 4];

    for (const y of [0.9, 1.8, 3.1]) {
      kit.member(at(x, y, z), at(x2, y, z2), 0.1, "frame");
    }

    kit.member(at(x, 1.8, z), at(x2, top, z2), 0.08, "frame");
    kit.member(at(x2, 1.8, z2), at(x, top, z), 0.08, "frame");
  });

  // The lower deck the open slide leaves from.
  kit.box(at(0, 1.75, 0), [2.6, 0.12, 2.6], "deck");

  // The gallery: an octagonal deck, railed in white.
  const gallery = new CylinderGeometry(2.4, 2.4, 0.25, 8).rotateY(Math.PI / 8);
  kit.add(gallery.translate(base.x, base.y + top + 0.125, base.z), "deck");

  // Its rail: a post at each corner, a top rail and a middle one.
  const corner = (k: number, y: number) => {
    const a = (k / 8) * Math.PI * 2;

    return at(Math.cos(a) * 2.3, y, Math.sin(a) * 2.3);
  };

  for (let k = 0; k < 8; k++) {
    kit.member(corner(k, top + 0.25), corner(k, top + 1.2), 0.08, "white");

    for (const y of [top + 0.7, top + 1.15]) {
      kit.member(corner(k, y), corner(k + 1, y), 0.07, "white");
    }
  }

  // The lantern house: white walls, dark glazing, a white cornice.
  const room = (radius: number, y: number, height: number, colour: Colour) =>
    kit.add(
      new CylinderGeometry(radius, radius, height, 8)
        .rotateY(Math.PI / 8)
        .translate(base.x, base.y + y + height / 2, base.z),
      colour
    );

  room(1.35, top + 0.25, 0.8, "white");
  room(1.3, top + 1.05, 0.9, "glass");
  room(1.5, top + 1.95, 0.2, "white");

  // The teal dome, a finial and a weathervane.
  const dome = top + 2.15;
  kit.add(
    new SphereGeometry(1.45, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2)
      .rotateY(Math.PI / 8)
      .translate(base.x, base.y + dome, base.z),
    "teal"
  );
  kit.post(at(0, dome + 1.3, 0), 1, 0.05, "post");
  kit.box(at(0, dome + 2.1, 0), [0.6, 0.18, 0.05], "post", 0.6);
}

function slides(kit: Kit, place: Place) {
  const [e, n] = EQUIPMENT.lighthouse;
  // Both leave the lighthouse, so measure their heights from its foot.
  const foot = place(e, n, 0).y;

  const along = (points: [number, number, number][]) =>
    points.map(([pe, pn, h]) => {
      const p = place(pe, pn, 0);

      return new Vector3(p.x, foot + h, p.z);
    });

  const tube = along(EQUIPMENT.tubeSlide);
  kit.tube(tube, 0.42, "yellow", 64);

  // Steel legs under the tube's bends.
  for (const point of [tube[3], tube[4]]) {
    const ground = place(point.x, -point.z, 0);
    kit.member(
      ground,
      new Vector3(point.x, point.y - 0.4, point.z),
      0.1,
      "post"
    );
  }

  // The open slide: a steel trough, a half-round with lips.
  const trough = (): [number, number][] => {
    const section: [number, number][] = [[-0.36, 0.3]];

    for (let k = 0; k <= 8; k++) {
      const a = Math.PI * (k / 8);
      section.push([-0.3 * Math.cos(a), 0.3 - 0.3 * Math.sin(a)]);
    }

    section.push([0.36, 0.3]);

    return section;
  };

  kit.sweep(along(EQUIPMENT.openSlide), trough, "steel", 32);
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
