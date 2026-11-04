// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PerspectiveCamera } from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Candidate,
  Category,
  follow,
  followed,
  getSnapshot,
  next,
  stop,
  useFollowCandidates,
  useFollowSpots,
  vehiclesAt,
} from "../../src/components/scene/follow/store";

/** Where a layer draws one: id, x, y, z and length. */
type Spot = [string, number, number, number, number];

/** A layer of vehicles: what can be followed, and where it's drawn. */
function Layer({
  category,
  list,
  spots = [],
}: {
  category: Category;
  list: Candidate[];
  spots?: Spot[];
}) {
  useFollowCandidates(category, list);
  const drawn = useFollowSpots(category);
  drawn.begin();

  for (const spot of spots) drawn.add(...spot);

  return null;
}

let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  stop();
  vi.unstubAllGlobals();
});

const mount = (layers: React.ReactNode) => act(() => root.render(layers));

const moving = (id: string, label = id): Candidate => ({
  id,
  label,
  moving: true,
});

describe("the follow store", () => {
  it("follows one under way before those standing still", () => {
    mount(
      <Layer
        category="bus"
        list={[{ id: "a", label: "a", moving: false }, moving("b")]}
      />
    );

    expect(getSnapshot().counts.bus).toBe(2);
    act(() => follow("bus"));
    expect(getSnapshot().following).toEqual({
      category: "bus",
      id: "b",
      label: "b",
    });
    expect(followed("bus")).toBe("b");
    expect(followed("train")).toBeNull();

    act(stop);
    expect(followed("bus")).toBeNull();
  });

  it("goes round them all before coming back to one", () => {
    mount(
      <Layer category="train" list={["c", "d", "e"].map((id) => moving(id))} />
    );

    act(() => follow("train"));
    const seen = [followed("train")];

    for (let i = 0; i < 2; i++) {
      act(next);
      seen.push(followed("train"));
    }

    expect(new Set(seen)).toEqual(new Set(["c", "d", "e"]));
    // Round again, never staying on the same one.
    act(next);
    expect(followed("train")).not.toBe(seen[2]);
  });

  it("passes over those not on the map", () => {
    mount(
      <Layer
        category="ship"
        list={[{ ...moving("f"), drawn: () => false }, moving("g")]}
      />
    );

    for (let i = 0; i < 3; i++) {
      act(() => follow("ship"));
      expect(followed("ship")).toBe("g");
      act(stop);
    }
  });

  it("fills in its label once that's known", () => {
    mount(<Layer category="bus" list={[moving("h", "")]} />);
    act(() => follow("bus"));
    mount(<Layer category="bus" list={[moving("h", "Route 2")]} />);

    expect(getSnapshot().following?.label).toBe("Route 2");
  });

  it("picks out what's drawn near a click, nearest first", () => {
    // Looking north (-z) from just above the ground.
    const camera = new PerspectiveCamera(50, 1, 1, 10_000);
    camera.position.set(0, 2, 0);
    camera.lookAt(0, 2, -1);
    camera.updateMatrixWorld();

    mount(
      <>
        <Layer
          category="bus"
          list={[moving("near"), moving("beside")]}
          spots={[
            ["near", 0, 2, -100, 12],
            ["beside", 5, 2, -100, 12],
            // Behind the camera.
            ["near", 0, 2, 100, 12],
            // Drawn, but no longer followable.
            ["gone", 1, 2, -100, 12],
          ]}
        />
        <Layer
          category="train"
          list={[moving("2601")]}
          // Each car of it.
          spots={[
            ["2601", -12, 2, -100, 20],
            ["2601", -18, 2, -100, 20],
          ]}
        />
      </>
    );

    const ids = (x: number, y: number) =>
      vehiclesAt(camera, x, y, 800).map(({ vehicle }) => vehicle.id);

    const [first] = vehiclesAt(camera, 0, 0, 800);
    expect(first).toMatchObject({
      vehicle: { category: "bus", id: "near", label: "near" },
      depth: 100,
      length: 12,
    });
    expect(ids(0, 0)).toEqual(["near", "beside"]);
    // Both its cars are in reach, but the train comes up once.
    expect(ids(-0.3, 0)).toEqual(["2601"]);
    expect(ids(0.9, 0.9)).toEqual([]);
  });
});
