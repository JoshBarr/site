import { BufferAttribute, BufferGeometry, Box3, Vector3 } from "three/webgpu";
import { DOTS_HIGH, DOTS_WIDE } from "./dots";
import {
  bezel,
  type Box,
  type PlacedFace,
  type PlacedStructure,
  type Slot,
} from "./layout";

// The signs as meshes: steel boxes and flat faces, a few kilometres' worth
// to a mesh. What each triangle's part of is in `part`, for the one
// material that draws them all.

/** What a vertex is part of. */
export const STEEL = 0;

/** A painted face: `uv` is where in the sheet. */
export const PAINTED = 1;

/** A message sign's lamps: `dot` is where in its grid, and which sign's. */
export const LAMPS = 2;

/** The back of a sign. */
export const BACK = 3;

/** A message sign's housing. */
export const HOUSING = 4;

/** Signs this far apart at most share a mesh, m. */
const CHUNK = 4000;

/** A message sign's housing is this deep, m; a board, this thick. */
const HOUSING_DEEP = 0.35;
const THICK = 0.05;

/** A lane sign's housing round its lamps, m. */
const LANE_BEZEL = 0.08;

/** A speed limit's disc has this many sides. */
const SIDES = 24;

type Triple = [number, number, number];

class Builder {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly uv: number[] = [];
  readonly part: number[] = [];
  readonly dot: number[] = [];
  readonly index: number[] = [];
  readonly box = new Box3();

  vertex(
    p: Triple,
    n: Triple,
    part: number,
    uv: [number, number] = [0, 0],
    dot: Triple = [0, 0, 0]
  ) {
    this.position.push(...p);
    this.normal.push(...n);
    this.uv.push(...uv);
    this.part.push(part);
    this.dot.push(...dot);
    this.box.expandByPoint(scratch.set(...p));

    return this.position.length / 3 - 1;
  }

  /** A box of steel (or housing): six flat sides. */
  addBox(
    { x, y, z, ux, uy = 0, uz, size: [long, tall, deep] }: Box,
    part: number
  ) {
    // Along, up, and across: across stays level, and up is square to both,
    // so a brace leans in the plane of its face.
    const flat = Math.hypot(ux, uz) || 1;
    const across: Triple = [-uz / flat, 0, ux / flat];
    const along: Triple = [ux, uy, uz];

    const up: Triple = [
      across[1] * along[2] - across[2] * along[1],
      across[2] * along[0] - across[0] * along[2],
      across[0] * along[1] - across[1] * along[0],
    ];

    const axes: Triple[] = [along, up, across];

    const half = [long / 2, tall / 2, deep / 2];

    for (let axis = 0; axis < 3; axis++) {
      for (const side of [-1, 1]) {
        const [a, b] = [(axis + 1) % 3, (axis + 2) % 3];

        // The corner `i` along one of the side's edges and `j` the other.
        const corner = (i: number, j: number, k: number) =>
          [x, y, z][k] +
          axes[axis][k] * half[axis] * side +
          axes[a][k] * half[a] * i +
          axes[b][k] * half[b] * j;

        const n: Triple = [
          axes[axis][0] * side,
          axes[axis][1] * side,
          axes[axis][2] * side,
        ];

        // Wound to face outward, whichever side.
        const corners = (
          side > 0
            ? [
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, 1],
              ]
            : [
                [-1, -1],
                [-1, 1],
                [1, 1],
                [1, -1],
              ]
        ).map(([i, j]) =>
          this.vertex(
            [corner(i, j, 0), corner(i, j, 1), corner(i, j, 2)],
            n,
            part
          )
        );

        this.index.push(
          corners[0],
          corners[1],
          corners[2],
          corners[0],
          corners[2],
          corners[3]
        );
      }
    }
  }

  /**
   * A flat rectangle facing (nx, nz), its middle at x, y, z, set `forward`
   * along its facing: `corner` gives each corner's uv and dot, by how far
   * across (0 at the viewer's left) and down (0 at the top) it is.
   */
  addQuad(
    face: PlacedFace,
    forward: number,
    part: number,
    corner: (
      across: number,
      down: number
    ) => { uv?: [number, number]; dot?: Triple } = () => ({})
  ) {
    const { x, y, z, nx, nz, width, height } = face;
    // The viewer's right, looking at it.
    const [rx, rz] = [nz, -nx];

    const at = (across: number, down: number) => {
      const { uv, dot } = corner(across, down);

      return this.vertex(
        [
          x + nx * forward + rx * (across - 0.5) * width,
          y + (0.5 - down) * height,
          z + nz * forward + rz * (across - 0.5) * width,
        ],
        [nx, 0, nz],
        part,
        uv,
        dot
      );
    };

    const [bl, br, tr, tl] = [at(0, 1), at(1, 1), at(1, 0), at(0, 0)];

    this.index.push(bl, br, tr, bl, tr, tl);
  }

  /** A flat disc facing (nx, nz), its uv from the square `slot` of a sheet. */
  addDisc(
    face: PlacedFace,
    forward: number,
    part: number,
    uv: (across: number, down: number) => [number, number]
  ) {
    const { x, y, z, nx, nz, width } = face;
    const [rx, rz] = [nz, -nx];

    const at = (across: number, down: number) =>
      this.vertex(
        [
          x + nx * forward + rx * (across - 0.5) * width,
          y + (0.5 - down) * width,
          z + nz * forward + rz * (across - 0.5) * width,
        ],
        [nx, 0, nz],
        part,
        uv(across, down)
      );

    const middle = at(0.5, 0.5);

    const rim = Array.from({ length: SIDES }, (_, k) => {
      const angle = (k / SIDES) * Math.PI * 2;

      return at(0.5 + Math.cos(angle) / 2, 0.5 - Math.sin(angle) / 2);
    });

    for (let k = 0; k < SIDES; k++) {
      this.index.push(middle, rim[k], rim[(k + 1) % SIDES]);
    }
  }

  build() {
    const geometry = new BufferGeometry();

    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(this.position), 3)
    );
    geometry.setAttribute(
      "normal",
      new BufferAttribute(new Float32Array(this.normal), 3)
    );
    geometry.setAttribute(
      "uv",
      new BufferAttribute(new Float32Array(this.uv), 2)
    );
    geometry.setAttribute(
      "part",
      new BufferAttribute(new Float32Array(this.part), 1)
    );
    geometry.setAttribute(
      "lamp",
      new BufferAttribute(new Float32Array(this.dot), 3)
    );
    geometry.setIndex(this.index);
    geometry.boundingBox = this.box.clone();
    geometry.computeBoundingSphere();

    return geometry;
  }
}

const scratch = new Vector3();

/** A face the other way round, for its back. */
const turned = (face: PlacedFace): PlacedFace => ({
  ...face,
  nx: -face.nx,
  nz: -face.nz,
});

/**
 * Meshes' worth of geometry for `placed`. `painted` says where in the sheet
 * (`sheet` px) each painted face is, and `lamps` which message sign's grid
 * is each one's, by the face itself.
 */
export function buildSigns(
  placed: PlacedStructure[],
  painted: Map<PlacedFace, Slot>,
  sheet: { width: number; height: number },
  lamps: Map<PlacedFace, number>
) {
  const chunks = new Map<string, Builder>();

  for (const structure of placed) {
    const key = `${Math.floor(structure.x / CHUNK)},${Math.floor(structure.z / CHUNK)}`;
    const builder = chunks.get(key) ?? new Builder();

    chunks.set(key, builder);

    for (const box of structure.boxes) builder.addBox(box, STEEL);

    for (const face of structure.faces) {
      const slot = painted.get(face);
      const grid = lamps.get(face);

      if (face.face.kind === "lane") {
        // A lane sign: its housing, and its lamps inside a thin bezel, the
        // DOTS_HIGH square at the left of its band (dark until it's given a
        // limit).
        builder.addBox(
          {
            x: face.x - (face.nx * HOUSING_DEEP) / 2,
            y: face.y,
            z: face.z - (face.nz * HOUSING_DEEP) / 2,
            ux: face.nz,
            uz: -face.nx,
            size: [face.width, face.height, HOUSING_DEEP],
          },
          HOUSING
        );

        if (grid !== undefined) {
          const per = DOTS_HIGH / (face.width - LANE_BEZEL * 2);

          builder.addQuad(face, 0.01, LAMPS, (across, down) => ({
            dot: [
              (across * face.width - LANE_BEZEL) * per,
              (down * face.height - LANE_BEZEL) * per,
              grid,
            ],
          }));
        }
      } else if (face.face.kind === "vms" && grid !== undefined) {
        // The lamps' grid sits inside the housing's bezel.
        const edge = bezel(face.face.size);
        const wide = DOTS_WIDE / (face.width - edge * 2);
        const high = DOTS_HIGH / (face.height - edge * 2);

        builder.addBox(
          {
            x: face.x - (face.nx * HOUSING_DEEP) / 2,
            y: face.y,
            z: face.z - (face.nz * HOUSING_DEEP) / 2,
            ux: face.nz,
            uz: -face.nx,
            size: [face.width, face.height, HOUSING_DEEP],
          },
          HOUSING
        );
        builder.addQuad(face, 0.01, LAMPS, (across, down) => ({
          dot: [
            (across * face.width - edge) * wide,
            (down * face.height - edge) * high,
            grid,
          ],
        }));
      } else if (slot) {
        const uv = (across: number, down: number): [number, number] => [
          (slot.x + across * slot.width) / sheet.width,
          (slot.y + down * slot.height) / sheet.height,
        ];

        if (face.face.kind === "speed") {
          builder.addDisc(face, 0, PAINTED, uv);
          builder.addDisc(turned(face), THICK, BACK, () => [0, 0]);
        } else {
          builder.addQuad(face, 0, PAINTED, (across, down) => ({
            uv: uv(across, down),
          }));
          builder.addQuad(turned(face), THICK, BACK);
        }
      }
    }
  }

  return [...chunks.values()].map((builder) => builder.build());
}
