import { LineSegments2 } from "three/examples/jsm/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
  NormalBlending,
} from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  cos,
  float,
  floor,
  instancedBufferAttribute,
  max,
  mix,
  positionGeometry,
  select,
  varying,
  sign,
  sin,
  smoothstep,
  vec3,
} from "three/tsl";
import { hazeTransmittance } from "../haze";
import { pixelAngle } from "../landmarks/common";
import { TrailMaterial } from "../trailMaterial";

// A bird, a wingspan of 1 across x, facing +z: a body, a fanned tail, and
// two wings hinged at the shoulder, each bent back at the wrist. Drawn from
// per-bird attributes: where it is and which way it faces; how big, how
// pale, how far its wings are raised and how far it's banked.

/** Out from the middle to the shoulder, of the span. */
const SHOULDER = 0.05;

const BODY = 0;
const WING = 1;

/**
 * Far off, a bird's drawn at least this many pixels across, up to this
 * many times its size: a speck over the harbour, not nothing.
 */
const MIN_PIXELS = 3.5;
const MAX_GROW = 16;

/** Yellow, as the aircraft's: the other things in the air. */
const TRAIL_COLOR = new Color(1, 0.8, 0.1);
const TRAIL_OPACITY = 0.55;

/** Pixels. */
const TRAIL_WIDTH = 1.5;

/** Wingtips, darker than the rest of the wing, from this far out. */
const TIP = 0.32;

function createBirdGeometry() {
  const positions: number[] = [];
  const parts: number[] = [];

  const triangle = (part: number, ...points: number[][]) => {
    for (const p of points) positions.push(p[0], p[1], p[2]);
    parts.push(part, part, part);
  };

  // The body: a stretched octahedron, nose to tail.
  const nose = [0, 0.005, 0.2];
  const tail = [0, 0, -0.15];
  const top = [0, 0.055, 0.04];
  const under = [0, -0.045, 0.03];
  const left = [0.06, 0, 0.03];
  const right = [-0.06, 0, 0.03];

  for (const end of [nose, tail]) {
    triangle(BODY, end, top, left);
    triangle(BODY, end, left, under);
    triangle(BODY, end, under, right);
    triangle(BODY, end, right, top);
  }

  // The tail, fanned.
  triangle(
    BODY,
    [0, 0.005, -0.12],
    [0.06, 0.005, -0.26],
    [-0.06, 0.005, -0.26]
  );

  // The wings: shoulder to wrist, then out to the tip, swept back.
  for (const side of [1, -1]) {
    const a = [side * SHOULDER, 0.01, 0.09];
    const b = [side * 0.25, 0.01, 0.075];
    const c = [side * 0.5, 0.01, -0.1];
    const d = [side * 0.25, 0.01, -0.1];
    const e = [side * SHOULDER, 0.01, -0.08];
    triangle(WING, a, b, d);
    triangle(WING, a, d, e);
    triangle(WING, b, c, d);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("part", new Float32BufferAttribute(parts, 1));
  geometry.computeVertexNormals();

  return geometry;
}

/**
 * Up to `capacity` birds in one mesh, each from its slot in `place` (x, y,
 * z, heading: radians from +z toward +x) and `shape` (wingspan, m; tones,
 * 100 × body + wing; wing angle, radians up; bank, radians, left wing
 * down).
 */
export function createFlight(capacity: number) {
  const place = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const shape = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const at = instancedBufferAttribute<"vec4">(place, "vec4");
  const look = instancedBufferAttribute<"vec4">(shape, "vec4");
  const centre = at.xyz;
  const heading = at.w;
  const span = look.x;
  const bodyTone = floor(look.y).div(100);
  const wingTone = look.y.sub(floor(look.y));
  const raised = look.z;
  const bank = look.w;
  const part = attribute<"float">("part", "float");
  const isWing = part.greaterThan(0.5);
  const local = positionGeometry;

  // The wings swung up or down about the shoulder.
  const side = sign(local.x);
  const reach = max(abs(local.x).sub(SHOULDER), 0);

  const hinged = vec3(
    side.mul(float(SHOULDER).add(reach.mul(cos(raised)))),
    local.y.add(reach.mul(sin(raised))),
    local.z
  );

  const swung = select(isWing, hinged, local);

  // Banked about its length: the left wing (+x) down for a left turn.
  const b = bank.negate();

  const banked = vec3(
    swung.x.mul(cos(b)).sub(swung.y.mul(sin(b))),
    swung.x.mul(sin(b)).add(swung.y.mul(cos(b))),
    swung.z
  );

  const grow = clamp(
    cameraPosition.distance(centre).mul(pixelAngle).mul(MIN_PIXELS).div(span),
    1,
    MAX_GROW
  );

  const sized = banked.mul(span.mul(grow));
  const c = cos(heading);
  const s = sin(heading);

  const material = new MeshStandardNodeMaterial({
    roughness: 0.85,
    flatShading: true,
    side: DoubleSide,
  });

  material.positionNode = vec3(
    sized.x.mul(c).add(sized.z.mul(s)),
    sized.y,
    sized.z.mul(c).sub(sized.x.mul(s))
  ).add(centre);

  // Wings darkening to the tips, as most of them do.
  const tipped = mix(
    wingTone,
    wingTone.mul(0.35),
    smoothstep(TIP, 0.5, abs(positionGeometry.x))
  );

  material.colorNode = vec3(select(isWing, tipped, bodyTone));

  const mesh = new Mesh(createBirdGeometry(), material);
  mesh.count = 0;
  mesh.frustumCulled = false;

  return { mesh, place, shape, capacity };
}

/**
 * Short trails behind the birds, up to `capacity` segments: each from
 * `segments` (start x, y, z, end x, y, z) and `ages` (0 new to 1 gone, at
 * either end), fading out behind.
 */
export function createBirdTrails(capacity: number) {
  const material = new TrailMaterial({
    color: TRAIL_COLOR,
    linewidth: TRAIL_WIDTH,
    worldUnits: false,
    transparent: true,
    depthWrite: false,
  });

  material.blending = NormalBlending;
  material.alphaToCoverage = false;
  // Its fog would be the template quad's, not the line's: hazed below.
  material.fog = false;

  const geometry = new LineSegmentsGeometry();

  const segments = new InstancedInterleavedBuffer(
    new Float32Array(capacity * 6),
    6,
    1
  );

  const ages = new InstancedInterleavedBuffer(
    new Float32Array(capacity * 2),
    2,
    1
  );

  geometry.setAttribute(
    "instanceStart",
    new InterleavedBufferAttribute(segments, 3, 0)
  );
  geometry.setAttribute(
    "instanceEnd",
    new InterleavedBufferAttribute(segments, 3, 3)
  );
  geometry.setAttribute(
    "instanceAgeStart",
    new InterleavedBufferAttribute(ages, 1, 0)
  );
  geometry.setAttribute(
    "instanceAgeEnd",
    new InterleavedBufferAttribute(ages, 1, 1)
  );
  geometry.instanceCount = 0;

  // The template quad's y is below 0.5 at a segment's start, above at its end.
  const end = <T extends "float" | "vec3">(
    type: T,
    start: string,
    finish: string
  ) =>
    select(
      positionGeometry.y.lessThan(0.5),
      attribute<T>(start, type),
      attribute<T>(finish, type)
    );

  const age = varying(end("float", "instanceAgeStart", "instanceAgeEnd"));

  const seen = varying(
    hazeTransmittance(
      cameraPosition,
      end("vec3", "instanceStart", "instanceEnd")
    )
  );

  material.opacityNode = float(1)
    .sub(age)
    .clamp(0, 1)
    .mul(TRAIL_OPACITY)
    .mul(seen);

  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  // After the sea (1).
  lines.renderOrder = 3;

  return { lines, segments, ages, capacity, material };
}
