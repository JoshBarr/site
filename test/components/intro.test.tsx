// @vitest-environment happy-dom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The homepage's intro over the scene while it loads: the heading, and the
// page filling as a progress bar behind it. The progress is kept in a
// module, so each test imports it afresh, with the React it renders with.

async function load() {
  vi.resetModules();

  return {
    ...(await import("@testing-library/react")),
    ...(await import("../../src/components/Intro")),
    ...(await import("../../src/components/LoadingFill")),
    ...(await import("../../src/components/scene/loading")),
  };
}

type Loaded = Awaited<ReturnType<typeof load>>;

// A no-break space keeps the dash off the start of a line.
const HEADING =
  "I'm Josh\u00a0– a designer, software engineer and guitarist from Te Whanganui-a-Tara/Wellington. Take a look around my hometown.";

afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
});

describe("the intro", () => {
  it("reads as the whole heading from the start", async () => {
    const l = await load();

    const { container } = l.render(<l.Intro hidden={false} />);

    const heading = l.screen.getByRole("heading", { level: 1 });

    expect(heading.textContent).toBe(HEADING);
    // The name's kept whole; the slash can end a line.
    expect(container.querySelector(".hero__name")?.textContent).toBe(
      "Te Whanganui-a-Tara"
    );
    expect(
      container.querySelector("wbr")?.previousElementSibling?.textContent
    ).toBe("/");
  });

  it("fades out when hidden", async () => {
    const l = await load();

    const { container, rerender } = l.render(<l.Intro hidden={false} />);

    expect(container.firstElementChild?.className).not.toContain(
      "hero__intro--hidden"
    );
    rerender(<l.Intro hidden />);
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

  it("follows the scene's first view", async () => {
    const l = await load();

    l.render(<l.LoadingFill hidden={false} />);
    expect(percent(l)).toBe(0);

    l.act(() => l.setFirstViewProgress(0.42));
    expect(percent(l)).toBe(42);

    l.act(() => l.setFirstViewProgress(1));
    expect(percent(l)).toBe(100);
    expect(l.screen.getByText("100%")).toBeTruthy();
  });

  it("leaves its rest to the stylesheet, and fades when hidden", async () => {
    const l = await load();

    l.setFirstViewProgress(0.5);

    const { rerender } = l.render(<l.LoadingFill hidden={false} />);

    const bar = l.screen.getByRole("progressbar");

    expect(bar.style.getPropertyValue("--rest")).toBe("0.5");
    expect(bar.className).not.toContain("hero__loading--hidden");

    rerender(<l.LoadingFill hidden />);
    expect(bar.className).toContain("hero__loading--hidden");
  });
});
