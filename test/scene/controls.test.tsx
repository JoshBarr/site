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

// The scene's controls: the toolbar's panels for places, following and
// settings, the time-travel button, the pills while following or
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
}: {
  onClouds?: (on: boolean) => void;
}) {
  const [clouds, setClouds] = useState(true);

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
});

describe("the scene's controls", () => {
  it("have a toolbar of places, following, settings and time travel", () => {
    setup();

    const toolbar = screen.getByRole("toolbar", { name: "Map" });

    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"))
    ).toEqual(["Places", "Follow transport", "Settings", "Time travel"]);
  });

  describe("settings", () => {
    it("turn the clouds and rain off and on", async () => {
      const onClouds = vi.fn();
      const { user } = setup(<Controls onClouds={onClouds} />);
      const panel = await open(user, "Settings");

      expect(
        within(panel).getByRole("heading", { name: "Settings" })
      ).toBeTruthy();
      const clouds = within(panel).getByRole("switch");

      expect(clouds.getAttribute("aria-checked")).toBe("true");
      await user.click(clouds);
      expect(onClouds).toHaveBeenLastCalledWith(false);
      expect(clouds.getAttribute("aria-checked")).toBe("false");

      await user.click(clouds);
      expect(onClouds).toHaveBeenLastCalledWith(true);
    });

    it("pick whether the camera flies or cuts, one or the other", async () => {
      const { user } = setup();
      const panel = await open(user, "Settings");
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

    it("follows one of a kind, moves on to the next, and stops", async () => {
      const { user } = setup();
      const panel = await open(user, "Follow transport");
      const buses = within(panel).getByRole("button", { name: /Buses/ });

      await user.click(buses);

      const first = getSnapshot().following;

      expect(buses.getAttribute("aria-pressed")).toBe("true");
      expect(first?.category).toBe("bus");
      expect(within(panel).getByText(first?.label ?? "?")).toBeTruthy();

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
  });

  describe("places", () => {
    it("send the camera to the one picked", async () => {
      const went = vi.fn();
      const disconnect = connectCamera(() => null, went);
      const { user } = setup();

      try {
        const panel = await open(user, "Places");

        await user.click(
          within(panel).getByRole("combobox", { name: "Go to a place" })
        );
        await user.click(
          await screen.findByRole("option", { name: "Airport" })
        );

        const airport = SHOTS.find(({ id }) => id === "airport");

        expect(went).toHaveBeenCalledWith(airport?.view);
      } finally {
        disconnect();
      }
    });

    it("copy a link to the view as it is, for a while saying so", async () => {
      history.replaceState(
        null,
        "",
        "/scene?shot=airport&t=2026-11-01T07:00:00Z"
      );

      const disconnect = connectCamera(
        () => [1750000.4, 5428000.6, 300.2, 1749000, 5427000, 0],
        () => {}
      );

      const { user } = setup();

      try {
        const panel = await open(user, "Places");

        const copy = within(panel).getByRole("button", {
          name: "Copy link to this view",
        });

        await user.click(copy);

        const copied = new URL(await navigator.clipboard.readText());

        expect(copied.pathname).toBe("/scene");
        expect(copied.searchParams.get("shot")).toBeNull();
        expect(copied.searchParams.get("t")).toBe("2026-11-01T07:00:00Z");
        expect(copied.searchParams.get("cam")).toBe(
          "1750000,5428001,300,1749000,5427000,0"
        );
        expect(copy.textContent).toBe("Copied");

        await waitFor(
          () => expect(copy.textContent).toBe("Copy link to this view"),
          {
            timeout: 2500,
          }
        );
      } finally {
        disconnect();
      }
    });

    it("copy nothing without a camera", async () => {
      const { user } = setup();
      const panel = await open(user, "Places");

      const copy = within(panel).getByRole("button", {
        name: "Copy link to this view",
      });

      await navigator.clipboard.writeText("as it was");
      await user.click(copy);

      expect(await navigator.clipboard.readText()).toBe("as it was");
      expect(copy.textContent).toBe("Copy link to this view");
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
