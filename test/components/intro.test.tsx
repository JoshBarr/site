// @vitest-environment happy-dom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The homepage's intro over the scene while it loads: the heading typed
// out, and the page filling as a progress bar behind it. The progress is
// kept in a module, so each test imports it afresh, with the React it
// renders with.

async function load() {
  vi.resetModules();

  return {
    ...(await import("@testing-library/react")),
    ...(await import("../../src/components/TypedIntro")),
    ...(await import("../../src/components/LoadingFill")),
    ...(await import("../../src/components/scene/loading")),
  };
}

type Loaded = Awaited<ReturnType<typeof load>>;

const wait = ({ act }: Loaded, ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

// A no-break space keeps the dash off the start of a line.
const HEADING =
  "I'm Josh\u00a0– a designer, software engineer and guitarist from Te Whanganui-a-Tara/Wellington. Take a look around my hometown.";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
});

afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
  vi.unstubAllGlobals();
});

describe("the typed intro", () => {
  it("reads as the whole heading, its letters laid out from the start", async () => {
    const l = await load();

    const { container } = l.render(
      <l.TypedIntro hidden={false} onTyped={() => {}} />
    );

    const heading = l.screen.getByRole("heading", { level: 1 });

    expect(heading.getAttribute("aria-label")).toBe(HEADING);
    expect(container.querySelectorAll(".hero__letter")).toHaveLength(
      HEADING.length
    );
    // The name's kept whole; the slash can end a line.
    expect(container.querySelector(".hero__name")?.textContent).toBe(
      "Te Whanganui-a-Tara"
    );
    expect(
      container.querySelector("wbr")?.previousElementSibling?.textContent
    ).toBe("/");
  });

  it("times each letter after the last, pausing at punctuation", async () => {
    const l = await load();

    const { container } = l.render(
      <l.TypedIntro hidden={false} onTyped={() => {}} />
    );

    const letters = [
      ...container.querySelectorAll<HTMLElement>(".hero__letter"),
    ];

    const at = letters.map((letter) =>
      parseInt(letter.style.getPropertyValue("--at"))
    );

    expect(at[0]).toBe(600);

    for (let i = 1; i < at.length; i++)
      expect(at[i]).toBeGreaterThan(at[i - 1]);

    const after = (c: string) => {
      const i = HEADING.indexOf(c);

      return at[i + 1] - at[i];
    };

    expect(after(".")).toBe(320);
    expect(after(",")).toBe(120);
    expect(after("J")).toBeLessThan(50);
    // The last has no next.
    expect(letters.at(-1)?.style.getPropertyValue("--for")).toBe("");
  });

  it("is done at once, a beat on, without motion", async () => {
    const l = await load();
    const typed = vi.fn();
    const typing = vi.fn();

    l.render(<l.TypedIntro hidden={false} onTyped={typed} onTyping={typing} />);

    expect(typing).toHaveBeenCalledWith({
      from: performance.now(),
      to: performance.now() + 900,
    });
    await wait(l, 899);
    expect(typed).not.toHaveBeenCalled();
    await wait(l, 1);
    expect(typed).toHaveBeenCalledTimes(1);
  });

  it("goes by the last letter's animation, when there is one", async () => {
    // The typing's own, as a browser would have it running on the last
    // letter: begun at 1234 ms, and finishing when it's told.
    class CSSAnimation extends Animation {
      readonly animationName = "hero-type";
      override startTime = 1234;
      finishTyping = () => {};
      override readonly ready = Promise.resolve(this);
      override readonly finished = new Promise<this>((resolve) => {
        this.finishTyping = () => resolve(this);
      });
    }

    vi.stubGlobal("CSSAnimation", CSSAnimation);
    const animation = new CSSAnimation();

    vi.spyOn(HTMLElement.prototype, "getAnimations").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("hero__letter--last") ? [animation] : [];
      }
    );

    const l = await load();
    const typed = vi.fn();
    const typing = vi.fn();

    l.render(<l.TypedIntro hidden={false} onTyped={typed} onTyping={typing} />);
    await wait(l, 0);

    const [{ from, to }] = typing.mock.calls[0];

    expect(from).toBe(1234);
    expect(to).toBeGreaterThan(from + 3000);

    // Not until it's finished, and a beat after.
    await wait(l, 10_000);
    expect(typed).not.toHaveBeenCalled();

    // The full stop's pause, then the hold.
    animation.finishTyping();
    await wait(l, 0);
    await wait(l, 320 + 900 - 1);
    expect(typed).not.toHaveBeenCalled();
    await wait(l, 1);
    expect(typed).toHaveBeenCalledTimes(1);
  });

  it("starts typed out, without calling back, when it's been seen", async () => {
    const l = await load();
    const typed = vi.fn();

    l.render(<l.TypedIntro hidden={false} typed onTyped={typed} />);
    await wait(l, 5000);

    expect(typed).not.toHaveBeenCalled();
    expect(l.screen.getByRole("heading").className).toContain(
      "hero__title--typed"
    );
  });

  it("fades out when hidden", async () => {
    const l = await load();

    const { container, rerender } = l.render(
      <l.TypedIntro hidden={false} typed onTyped={() => {}} />
    );

    expect(container.firstElementChild?.className).not.toContain(
      "hero__intro--hidden"
    );
    rerender(<l.TypedIntro hidden typed onTyped={() => {}} />);
    expect(container.firstElementChild?.className).toContain(
      "hero__intro--hidden"
    );
  });
});

describe("the loading fill", () => {
  const percent = ({ screen }: Loaded) =>
    Number(
      screen
        .getByRole("progressbar", { name: "Loading the scene" })
        .getAttribute("aria-valuenow")
    );

  it("is empty until it knows when the typing ends", async () => {
    const l = await load();

    l.setFirstViewProgress(0.8);
    l.render(<l.LoadingFill hidden={false} typing={null} />);

    expect(percent(l)).toBe(0);
  });

  it("follows whichever's further behind, the scene or the typing", async () => {
    const l = await load();
    const from = performance.now();

    l.setFirstViewProgress(0.8);
    l.render(
      <l.LoadingFill hidden={false} typing={{ from, to: from + 1000 }} />
    );

    // Typing's 40% through, as it ticks every 200 ms.
    await wait(l, 400);
    expect(percent(l)).toBe(40);

    await wait(l, 600);
    expect(percent(l)).toBe(80);

    l.act(() => l.setFirstViewProgress(1));
    expect(percent(l)).toBe(100);
    expect(l.screen.getByText("100%")).toBeTruthy();
  });

  it("rises with the scene once the typing's done, and stops ticking", async () => {
    const l = await load();
    const from = performance.now() - 5000;

    l.render(
      <l.LoadingFill hidden={false} typing={{ from, to: from + 1000 }} />
    );
    l.act(() => l.setFirstViewProgress(0.42));

    expect(percent(l)).toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves its rest to the stylesheet, and fades when hidden", async () => {
    const l = await load();

    // Typed out a while ago.
    const typing = {
      from: performance.now() - 2000,
      to: performance.now() - 1000,
    };

    l.setFirstViewProgress(0.5);

    const { rerender } = l.render(
      <l.LoadingFill hidden={false} typing={typing} />
    );

    const bar = l.screen.getByRole("progressbar");

    expect(bar.style.getPropertyValue("--rest")).toBe("0.5");
    expect(bar.className).not.toContain("hero__loading--hidden");

    rerender(<l.LoadingFill hidden typing={typing} />);
    expect(bar.className).toContain("hero__loading--hidden");
  });
});
