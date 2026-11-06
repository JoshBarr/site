// @vitest-environment happy-dom
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSceneTime } from "../../src/components/scene/clock";
import { SceneControls } from "../../src/components/scene/controls/SceneControls";
import {
  type Candidate,
  type Category,
  getSnapshot,
  setCut,
  stop,
  useFollowCandidates,
} from "../../src/components/scene/follow/store";
import { connectCamera, SHOTS } from "../../src/components/scene/shots/shots";
import { getMapView, setMapView } from "../../src/components/scene/mapView";
import {
  FOCUS_SHIFT_MAX,
  getFocusShift,
  setFocusShift,
} from "../../src/components/scene/lens";

// The scene's controls: the toolbar's panels for places, following and
// the camera, the time-travel button, the pills while following or
// replaying, and where the data's from.

/** What a layer lists to follow, as it would while it's drawn. */
function Layer({ category, list }: { category: Category; list: Candidate[] }) {
  useFollowCandidates(category, list);

  return null;
}

const bus = (id: string): Candidate => ({
  id,
  label: `Bus ${id}`,
  moving: true,
});

/** The controls over a scene with two buses and a train, clouds on. */
function Controls({
  onClouds = () => {},
  onWind = () => {},
}: {
  onClouds?: (on: boolean) => void;
  onWind?: (on: boolean) => void;
}) {
  const [clouds, setClouds] = useState(true);
  const [wind, setWind] = useState(false);

  return (
    <>
      <Layer category="bus" list={[bus("2158"), bus("2777")]} />
      <Layer
        category="train"
        list={[{ id: "FP4123", label: "Kāpiti FP4123", moving: true }]}
      />
      <SceneControls
        clouds={clouds}
        onCloudsChange={(on) => {
          setClouds(on);
          onClouds(on);
        }}
        wind={wind}
        onWindChange={(on) => {
          setWind(on);
          onWind(on);
        }}
      />
    </>
  );
}

const setup = (element: React.ReactElement = <Controls />) => {
  // The drawer passes touches through to the scene, and the controls'
  // stylesheet takes them back for the bar: stylesheets aren't loaded here,
  // so user-event would think the bar can't be clicked.
  const user = userEvent.setup({ pointerEventsCheck: 0 });

  return { user, ...render(element) };
};

/** Opens the toolbar's panel for `name`, and returns it. */
async function open(user: ReturnType<typeof userEvent.setup>, name: string) {
  const toolbar = screen.getByRole("toolbar", { name: "Map" });

  await user.click(within(toolbar).getByRole("button", { name }));

  return screen.findByRole("dialog");
}

beforeEach(() => {
  history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  stop();
  setCut(false);
  setSceneTime(null);
  setMapView(false);
  setFocusShift(0);
});

describe("the scene's controls", () => {
  it("have a toolbar of map view, clouds, wind, places, following, camera, time travel and info", () => {
    setup();

    const toolbar = screen.getByRole("toolbar", { name: "Map" });

    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"))
    ).toEqual([
      "Map view",
      "Clouds and rain",
      "Wind",
      "Places",
      "Follow transport",
      "Camera",
      "Time travel",
      "About the data",
    ]);
  });

  it("turn the clouds and rain off and on from the toolbar", async () => {
    const onClouds = vi.fn();
    const { user } = setup(<Controls onClouds={onClouds} />);
    const toolbar = screen.getByRole("toolbar", { name: "Map" });

    const clouds = within(toolbar).getByRole("button", {
      name: "Clouds and rain",
    });

    expect(clouds.getAttribute("aria-pressed")).toBe("true");
    await user.click(clouds);
    expect(onClouds).toHaveBeenLastCalledWith(false);
    expect(clouds.getAttribute("aria-pressed")).toBe("false");

    await user.click(clouds);
    expect(onClouds).toHaveBeenLastCalledWith(true);
    expect(clouds.getAttribute("aria-pressed")).toBe("true");
  });

  it("show the wind and hide it again from the toolbar, off to begin with", async () => {
    const onWind = vi.fn();
    const { user } = setup(<Controls onWind={onWind} />);
    const toolbar = screen.getByRole("toolbar", { name: "Map" });
    const wind = within(toolbar).getByRole("button", { name: "Wind" });

    expect(wind.getAttribute("aria-pressed")).toBe("false");
    await user.click(wind);
    expect(onWind).toHaveBeenLastCalledWith(true);
    expect(wind.getAttribute("aria-pressed")).toBe("true");

    await user.click(wind);
    expect(onWind).toHaveBeenLastCalledWith(false);
    expect(wind.getAttribute("aria-pressed")).toBe("false");
  });

  it("switch the map view on and off, showing which it's in", async () => {
    const { user } = setup();
    const toolbar = screen.getByRole("toolbar", { name: "Map" });
    const map = within(toolbar).getByRole("button", { name: "Map view" });

    expect(map.getAttribute("aria-pressed")).toBe("false");
    await user.click(map);
    expect(getMapView()).toBe(true);
    expect(map.getAttribute("aria-pressed")).toBe("true");

    // Or from the keyboard, in the scene: the button keeps up.
    act(() => setMapView(false));
    expect(map.getAttribute("aria-pressed")).toBe("false");
  });

  describe("camera", () => {
    it("pick whether the camera flies or cuts, one or the other", async () => {
      const { user } = setup();
      const panel = await open(user, "Camera");
      const moves = within(panel).getByRole("group", { name: "Camera moves" });
      const cut = within(moves).getByRole("button", { name: "Cut" });
      const fly = within(moves).getByRole("button", { name: "Fly" });

      expect(fly.getAttribute("aria-pressed")).toBe("true");

      await user.click(cut);
      expect(getSnapshot().cut).toBe(true);
      expect(cut.getAttribute("aria-pressed")).toBe("true");

      // Pressing it again leaves it pressed.
      await user.click(cut);
      expect(getSnapshot().cut).toBe(true);

      await user.click(fly);
      expect(getSnapshot().cut).toBe(false);
    });

    it("bring the focus nearer or farther than autofocus has it", async () => {
      const { user } = setup();
      let panel = await open(user, "Camera");
      const focus = within(panel).getByRole("slider", { name: "Focus" });

      expect(getFocusShift()).toBe(0);
      expect(panel.textContent).toContain("Auto");

      focus.focus();
      await user.keyboard("{ArrowRight}{ArrowRight}");
      expect(getFocusShift()).toBeCloseTo(0.2);
      await user.keyboard("{End}");
      expect(getFocusShift()).toBe(FOCUS_SHIFT_MAX);
      expect(panel.textContent).toContain("×4.0");

      // Shut and opened again, it shows where focus is.
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      panel = await open(user, "Camera");
      expect(
        within(panel).getByRole("slider", { name: "Focus" })
      ).toHaveProperty("value", String(FOCUS_SHIFT_MAX));

      within(panel).getByRole("slider", { name: "Focus" }).focus();
      await user.keyboard("{Home}");
      expect(getFocusShift()).toBe(-FOCUS_SHIFT_MAX);
    });
  });

  describe("following", () => {
    it("counts what there is of each kind, and can't follow what isn't", async () => {
      const { user } = setup();
      const panel = await open(user, "Follow transport");

      const row = (name: string) =>
        within(panel).getByRole("button", { name: new RegExp(name) });

      expect(row("Buses").textContent).toContain("2");
      expect(row("Trains").textContent).toContain("1");
      expect(row("Ships").hasAttribute("disabled")).toBe(true);
      expect(row("Aircraft").hasAttribute("disabled")).toBe(true);
    });

    it("follows one of a kind at random, moves on to the next, and stops", async () => {
      const { user } = setup();
      const panel = await open(user, "Follow transport");

      // First the kind, then one of them.
      await user.click(within(panel).getByRole("button", { name: /Buses/ }));
      await user.click(
        within(panel).getByRole("button", { name: "Lucky dip" })
      );

      const first = getSnapshot().following;

      expect(first?.category).toBe("bus");
      expect(
        within(panel)
          .getByRole("button", { name: first?.label, pressed: true })
          .getAttribute("aria-pressed")
      ).toBe("true");

      await user.click(within(panel).getByRole("button", { name: "Next" }));

      const second = getSnapshot().following;

      expect([first?.id, second?.id].sort()).toEqual(["2158", "2777"]);

      // The pill in the bar says what, and lets go.
      const stopping = screen.getByRole("button", { name: "Stop following" });

      expect(stopping.parentElement?.textContent).toContain(second?.label);
      await user.click(stopping);

      expect(getSnapshot().following).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Stop following" })
      ).toBeNull();
    });

    it("follows the one picked from a kind's list, and goes back to the kinds", async () => {
      const { user } = setup();
      const panel = await open(user, "Follow transport");

      await user.click(within(panel).getByRole("button", { name: /Buses/ }));

      const list = within(panel).getByRole("list", { name: "Buses" });
      const [, second] = within(list).getAllByRole("button");

      await user.click(second);

      expect(getSnapshot().following?.label).toBe(second.textContent);
      expect(second.getAttribute("aria-pressed")).toBe("true");

      await user.click(
        within(panel).getByRole("button", { name: "All kinds of transport" })
      );

      expect(
        within(panel)
          .getByRole("button", { name: /Buses/ })
          .getAttribute("aria-pressed")
      ).toBe("true");
    });
  });

  describe("places", () => {
    it("send the camera to the one picked", async () => {
      const went = vi.fn();
      const disconnect = connectCamera(() => null, went);
      const { user } = setup();

      try {
        const panel = await open(user, "Places");

        const button = within(panel).getByRole("button", { name: "Airport" });

        expect(within(panel).getAllByRole("listitem")).toHaveLength(
          SHOTS.length
        );

        await user.click(button);

        const airport = SHOTS.find(({ id }) => id === "airport");

        expect(went).toHaveBeenCalledWith(airport?.view);
        expect(button.getAttribute("aria-pressed")).toBe("true");
      } finally {
        disconnect();
      }
    });
  });

  it("open and close the time-travel drawer", async () => {
    const { user } = setup();
    const button = screen.getByRole("button", { name: "Time travel" });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("say when the scene's replaying, and take it back to live", async () => {
    const { user } = setup();

    expect(screen.queryByRole("button", { name: /Back to live/ })).toBeNull();

    act(() => setSceneTime(Date.parse("2026-11-01T07:30:00+13:00")));

    const back = await screen.findByRole("button", { name: /Back to live/ });

    expect(back.parentElement?.textContent).toContain("Sun, 1 Nov, 7:30 am");

    await user.click(back);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Back to live/ })).toBeNull()
    );
  });

  it("say where the data's from, with its licences", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: "About the data" }));
    const panel = await screen.findByRole("dialog");

    expect(within(panel).getByRole("heading", { name: "Map" })).toBeTruthy();
    expect(within(panel).getByRole("heading", { name: "Live" })).toBeTruthy();

    const links = within(panel).getAllByRole("link");

    expect(links.length).toBeGreaterThan(5);
    expect(links.some((a) => /Metlink/.test(a.textContent ?? ""))).toBe(true);
    expect(links.every((a) => a.getAttribute("href")?.startsWith("http"))).toBe(
      true
    );
  });
});
