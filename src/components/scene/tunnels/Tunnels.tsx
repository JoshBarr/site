import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import {
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Vector3,
} from "three/webgpu";
import {
  attribute,
  cos,
  float,
  mix,
  positionLocal,
  select,
  vec3,
} from "three/tsl";
import { skyBrightness } from "../environment";
import { TileIndex } from "../terrain/manifest";
import { roadColor } from "../traffic/markings";
import { Bore, loadRoadBores, underground } from "./bores";
import {
  createLinings,
  createPortals,
  LAMP,
  LAMP_EVERY,
  ROAD,
} from "./geometry";
import { createCutaway, cutaway, cutRadius, LINING_ORDER } from "./reveal";

/**
 * Portals are drawn this near the camera, m: beyond, a headwall's under a
 * pixel or two, and would only glint.
 */
const PORTAL_RANGE = 9000;

/**
 * After the camera's on what it follows (0.5), and before the frame's
 * drawn (1): the cut's round where the vehicle is now.
 */
const CUT_PRIORITY = 0.75;

/**
 * How bright a lining is under its lamps, as a share of its own tone: by
 * day, and at night, when the eye's used to the dark and a tunnel at its
 * daytime brightness would be the brightest thing for miles. Half way from
 * one lamp to the next it's BETWEEN_LAMPS of that.
 */
const LIT_DAY = 1;
const LIT_NIGHT = 0.4;
const BETWEEN_LAMPS = 0.6;

/** The sky's brightness on a moonless night, as environment.ts has it. */
const NIGHT_SKY = 0.2;

/** 0 by day to 1 on a moonless night, from how much of the sky's light is left. */
const night = float(1)
  .sub(skyBrightness)
  .div(1 - NIGHT_SKY)
  .clamp(0, 1);

/** The lamps themselves, as many times a white wall under them. */
const LAMP_GLOW = 5;

/** What's left of the ground over a lining, at the middle of the cut. */
const GROUND_LEFT = 0.1;

/**
 * A tunnel's mouth, by day and at night: the lamps inside, from outside.
 * Black against daylight, a glow in the dark.
 */
const MOUTH_DAY = 0.004;
const MOUTH_NIGHT = 0.035;

const cameraPosition = new Vector3();

/**
 * Linings are only ever seen through the ground, cut away around something
 * followed through them (see reveal.ts): blended over it, fading out toward
 * the cut's edge, and lit by their own lamps whatever the sun's doing.
 */
function createLiningMaterial() {
  const material = new MeshBasicNodeMaterial({ transparent: true });
  const part = attribute<"float">("part", "float");
  const mark = attribute<"vec4">("mark", "vec4");
  const tone = attribute<"vec3">("color", "vec3");

  const isPart = (p: number) =>
    part.greaterThan(p - 0.5).and(part.lessThan(p + 0.5));

  // Pools of light under the lamps, half a spacing in from each end.
  const pool = cos(
    mark.y
      .div(LAMP_EVERY)
      .sub(0.5)
      .mul(2 * Math.PI)
  )
    .mul(0.5)
    .add(0.5);

  const lit = mix(LIT_DAY, LIT_NIGHT, night);

  material.colorNode = select(
    isPart(LAMP),
    tone.mul(LAMP_GLOW),
    select(isPart(ROAD), roadColor(mark), tone).mul(mix(BETWEEN_LAMPS, 1, pool))
  ).mul(lit);
  material.opacityNode = cutaway().mul(1 - GROUND_LEFT);
  // With nothing cut away there's nothing to see: no triangles at all,
  // rather than a mesh switched off, so its pipeline's built with the rest
  // and not when a train first goes underground.
  material.positionNode = select(
    cutRadius.greaterThan(0),
    positionLocal,
    vec3(0)
  );

  return material;
}

function createPortalMaterial() {
  const material = new MeshStandardNodeMaterial({ roughness: 0.9 });
  material.colorNode = attribute<"vec3">("color", "vec3");
  material.emissiveNode = vec3(
    attribute<"vec4">("mark", "vec4").x.mul(mix(MOUTH_DAY, MOUTH_NIGHT, night))
  );

  return material;
}

/**
 * The tunnels `bores` are: a portal on each end that has one and, if
 * they're `lined`, their insides, which show when something's followed
 * through them. While it's mounted they're listed as underground.
 */
export function Bores({
  bores,
  name,
  lined = true,
}: {
  bores: Bore[];
  name: string;
  /** Not where nothing that goes through can be followed. */
  lined?: boolean;
}) {
  const camera = useThree((state) => state.camera);

  const { group, portals, lining, materials } = useMemo(() => {
    const materials = {
      lining: createLiningMaterial(),
      portal: createPortalMaterial(),
    };

    const group = new Group();

    const lining =
      lined && bores.length
        ? new Mesh(createLinings(bores), materials.lining)
        : null;

    if (lining) {
      // Its vertices are wherever the cut is, or nowhere.
      lining.frustumCulled = false;
      lining.renderOrder = LINING_ORDER;
      lining.name = "tunnel linings";
      group.add(lining);
    }

    const portals = createPortals(bores).map(({ box, geometry }) => {
      const mesh = new Mesh(geometry, materials.portal);
      mesh.receiveShadow = true;
      mesh.name = "tunnel portals";
      group.add(mesh);

      return { box, mesh };
    });

    return { group, portals, lining, materials };
  }, [bores, lined]);

  useEffect(() => underground.add(bores), [bores]);

  useEffect(
    () => () => {
      lining?.geometry.dispose();

      for (const { mesh } of portals) mesh.geometry.dispose();
      group.clear();
      materials.lining.dispose();
      materials.portal.dispose();
    },
    [group, portals, lining, materials]
  );

  useFrame(() => {
    camera.getWorldPosition(cameraPosition);

    for (const { box, mesh } of portals) {
      mesh.visible = box.distanceToPoint(cameraPosition) < PORTAL_RANGE;
    }
  });

  return <primitive object={group} name={name} />;
}

/** The ground cut away around what's followed through a tunnel. */
function Cutaway() {
  const cut = useMemo(createCutaway, []);

  useEffect(() => cut.dispose, [cut]);

  useFrame((_, delta) => cut.update(delta), CUT_PRIORITY);

  return <primitive object={cut.mesh} name="tunnel cutaway" />;
}

/**
 * The road tunnels: Mt Victoria, the Terrace, the bus tunnel and the rest,
 * with a portal at each end. (The railway lays its own, with its track.)
 * And for all of them, the ground cut away around a bus or train the
 * camera's following through one.
 */
export function Tunnels({ index }: { index: TileIndex }) {
  const [bores, setBores] = useState<Bore[] | null>(null);

  useEffect(() => {
    loadRoadBores(index).then(setBores, (e) => console.error(e));
  }, [index]);

  return (
    <>
      <Cutaway />
      {bores && <Bores bores={bores} name="road tunnels" />}
    </>
  );
}
