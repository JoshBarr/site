import { Group, Mesh } from "three/webgpu";
import { rocket, stageFor, stageSpan } from "./rockets";
import {
  bluebird,
  cosmos,
  hubble,
  satellite,
  satelliteSpan,
} from "./spacecraft";
import { iss, tiangong } from "./stations";
import type { Materials } from "./surface";

// The satellite followed, through the telescope: which model it's drawn
// as, by its name. The stations, Hubble, the BlueBirds and the Cosmos
// family each have their own; rocket bodies are their stage; anything else
// is a bus with wings. In metres, x along its way, y up away from the Earth,
// z across; their arrays turn about their own z to the sun.

export interface Builder {
  model: Group;
  /** A group for wings that turn to the sun together, about z at `x, y, z`. */
  arrays: (x: number, y: number, z: number) => Group;
}

export interface Design {
  /** Which model: those with the same are drawn alike. */
  key: string;
  /** About how far across it is, m, which the shot's framed by. */
  span: number;
  /** Tumbling end over end, rad/s, as spent stages do; else held steady. */
  tumble: number;
  build: (m: Materials, builder: Builder) => void;
}

const designs = new Map<string, Design>();

function design(name: string): Design {
  if (name.startsWith("ISS")) {
    return { key: "iss", span: 110, tumble: 0, build: iss };
  }

  if (name.startsWith("CSS")) {
    return { key: "tiangong", span: 55, tumble: 0, build: tiangong };
  }

  if (name.startsWith("HST")) {
    return { key: "hubble", span: 14, tumble: 0, build: hubble };
  }

  // The first five BlueBirds are 8 m square, those after 15 m.
  const blue = /^SPACEMOBILE-0*(\d+)/.exec(name);

  if (blue) {
    const size = Number(blue[1]) <= 5 ? 8 : 15;

    return {
      key: `bluebird ${size}`,
      span: size * 1.42,
      tumble: 0,
      build: bluebird(size),
    };
  }

  if (/^(COSMOS|INTERCOSMOS|OKEAN|KORONAS)/.test(name)) {
    return { key: "cosmos", span: 8, tumble: 0, build: cosmos };
  }

  if (/R\/B|DEB/.test(name)) {
    const [key, stage] = stageFor(name);

    return {
      key: `rocket ${key}`,
      span: stageSpan(stage),
      tumble: 0.05 + (0.15 * ((name.length * 7919) % 101)) / 101,
      build: rocket(stage),
    };
  }

  return {
    key: `satellite ${name}`,
    span: satelliteSpan(name),
    tumble: 0,
    build: satellite(name),
  };
}

/** The design `name` is drawn as. */
export function designFor(name: string) {
  let found = designs.get(name);

  if (!found) {
    found = design(name);
    designs.set(name, found);
  }

  return found;
}

export interface Craft {
  model: Group;
  /** Wings that turn to the sun, each about its own z. */
  arrays: Group[];
  design: Design;
}

/** A model of `design` in `materials`, about its middle. */
export function createCraft(design: Design, materials: Materials): Craft {
  const model = new Group();
  const arrays: Group[] = [];

  design.build(materials, {
    model,
    arrays: (x, y, z) => {
      const group = new Group();
      group.position.set(x, y, z);
      model.add(group);
      arrays.push(group);

      return group;
    },
  });

  return { model, arrays, design };
}

/** Frees its geometry; the materials are shared, and freed by their owner. */
export function disposeCraft({ model }: Craft) {
  model.traverse((object) => {
    if (object instanceof Mesh) object.geometry.dispose();
  });
}
