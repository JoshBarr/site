// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { pressRing } from "../../src/components/scene/pressRing";

describe("the ring under a held press", () => {
  let unhandled = 0;

  const caught = () => {
    unhandled++;
  };

  afterEach(() => {
    process.off("unhandledRejection", caught);
    unhandled = 0;
    document.body.replaceChildren();
  });

  it.each(["cancel", "lock", "miss"] as const)(
    "goes on %s, leaving no rejection unhandled",
    async (how) => {
      process.on("unhandledRejection", caught);
      pressRing(10, 10, 400)[how]();
      // Past the longest fade.
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(unhandled).toBe(0);
      expect(document.body.children).toHaveLength(0);
    }
  );
});
