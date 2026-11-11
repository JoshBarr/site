// @vitest-environment happy-dom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The type's grid over the page, shown and hidden with ⌘' (Ctrl+' off a
// Mac). Whether it's shown is kept in the module, and in sessionStorage for
// the visit, so each test starts with both afresh.

async function load() {
  vi.resetModules();
  sessionStorage.clear();

  return {
    ...(await import("@testing-library/react")),
    ...(await import("../../src/components/GridOverlay")),
  };
}

afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
});

describe("the grid overlay", () => {
  it("is hidden until ⌘' shows it, and ⌘' again hides it", async () => {
    const l = await load();

    l.render(<l.GridOverlay />);
    expect(l.screen.queryByTestId("grid-overlay")).toBeNull();

    l.fireEvent.keyDown(window, { key: "'", code: "Quote", metaKey: true });

    const overlay = l.screen.getByTestId("grid-overlay");

    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.querySelectorAll(".grid-overlay__column")).toHaveLength(12);

    l.fireEvent.keyDown(window, { key: "'", code: "Quote", metaKey: true });
    expect(l.screen.queryByTestId("grid-overlay")).toBeNull();
  });

  it("takes Ctrl+' too, and ignores the key alone or held down", async () => {
    const l = await load();

    l.render(<l.GridOverlay />);

    l.fireEvent.keyDown(window, { key: "'", code: "Quote" });
    expect(l.screen.queryByTestId("grid-overlay")).toBeNull();

    l.fireEvent.keyDown(window, { key: "'", code: "Quote", ctrlKey: true });
    expect(l.screen.getByTestId("grid-overlay")).toBeTruthy();

    l.fireEvent.keyDown(window, {
      key: "'",
      code: "Quote",
      ctrlKey: true,
      repeat: true,
    });
    expect(l.screen.getByTestId("grid-overlay")).toBeTruthy();
  });

  it("stays as it was across pages", async () => {
    const l = await load();

    const { unmount } = l.render(<l.GridOverlay />);

    l.fireEvent.keyDown(window, { key: "'", code: "Quote", metaKey: true });
    unmount();

    l.render(<l.GridOverlay />);
    expect(l.screen.getByTestId("grid-overlay")).toBeTruthy();
    expect(sessionStorage.getItem("grid-overlay")).toBe("1");
  });
});
