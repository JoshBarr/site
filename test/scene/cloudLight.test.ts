import { describe, expect, it } from "vitest";
import { lightUnder } from "../../src/components/scene/cloudLight";
import { throughCloud } from "../../src/components/scene/clouds/density";
import {
  cloudsOver,
  shapesFor,
} from "../../src/components/scene/clouds/layers";
import { skylightFor } from "../../src/components/scene/environment";
import { skyFor } from "../../src/components/scene/sky/skyModel";
import type { Conditions } from "../../src/components/scene/weather";

// The light under cloud: what's left of the sun's beam, and the even light
// the cloud passes, which the ground, the haze and the deck's underside all
// have from the one sum.

/** Air you can see 30 km through, as the scene's haze has it. */
const AIR = { haze: 3.912 / 30000, hazeHeight: 900 };

const sky = (cloudCover: number): Conditions => ({
  time: new Date(0).toISOString(),
  cloudCover,
  cloudBase: 900,
  visibility: 30000,
  humidity: 0.7,
  precipitation: 0,
  wind: { speed: 7, direction: 340 },
  windAloft: { speed: 10, direction: 340 },
});

describe("throughCloud", () => {
  it("passes less the thicker the cloud, and all of it through none", () => {
    expect(throughCloud(0, 1)).toBe(1);
    expect(throughCloud(600, 1)).toBeLessThan(throughCloud(300, 1));
    expect(throughCloud(1250, 1)).toBeLessThan(throughCloud(600, 1));
  });

  it("passes about a third through a full deck", () => {
    expect(throughCloud(1250, 1)).toBeGreaterThan(0.25);
    expect(throughCloud(1250, 1)).toBeLessThan(0.4);
  });
});

describe("lightUnder", () => {
  it("leaves a clear sky's light as it is", () => {
    expect(lightUnder([], 2.6, 0.5)).toEqual({ beam: 1, diffuse: 0.5 });

    expect(lightUnder([{ cover: 0, passes: 0.3 }], 2.6, 0.5)).toEqual({
      beam: 1,
      diffuse: 0.5,
    });
  });

  it("takes the beam under a deck, and passes its share of all of it", () => {
    const { beam, diffuse } = lightUnder([{ cover: 1, passes: 0.3 }], 2.6, 0.5);

    expect(beam).toBe(0);
    expect(diffuse).toBeCloseTo(0.3 * 3.1);
  });

  it("under broken cloud, has the beam in the gaps and more even light", () => {
    const { beam, diffuse } = lightUnder(
      [{ cover: 0.5, passes: 0.5 }],
      2.6,
      0.5
    );

    expect(beam).toBe(0.5);
    // Half the open sky, and half of what the cloud passes.
    expect(diffuse).toBeCloseTo(0.25 + 0.25 * 3.1);
    // Less in all than under a clear sky: the cloud sends the rest back up.
    expect(beam * 2.6 + diffuse).toBeLessThan(3.1);
  });

  it("never has more light under cloud than came down on it", () => {
    for (const cover of [0.1, 0.4, 0.7, 1]) {
      for (const passes of [0.1, 0.5, 1]) {
        const { beam, diffuse } = lightUnder(
          [
            { cover, passes },
            { cover: 0.6, passes: 0.4 },
          ],
          2.6,
          0.5
        );

        expect(beam * 2.6 + diffuse).toBeLessThanOrEqual(3.1 + 1e-9);
        expect(diffuse).toBeGreaterThan(0);
      }
    }
  });

  it("takes each layer in turn: the lower has what the higher let by", () => {
    const high = { cover: 1, passes: 0.5 };
    const low = { cover: 1, passes: 0.4 };

    expect(lightUnder([high, low], 2, 0).diffuse).toBeCloseTo(2 * 0.5 * 0.4);
  });
});

describe("cloudsOver", () => {
  it("has no cloud in the way of a clear sky's light", () => {
    for (const { cover } of cloudsOver(sky(0))) expect(cover).toBe(0);
  });

  it("closes the low layer over a full cover, as the march's deck does", () => {
    const [, low] = cloudsOver(sky(1));

    expect(low.cover).toBe(1);
    expect(low.passes).toBeGreaterThan(0.25);
    expect(low.passes).toBeLessThan(0.4);
  });

  it("is the cloud over the scene whether or not it's drawn", () => {
    expect(shapesFor(sky(0.6), false).low[2]).toBe(0);
    expect(cloudsOver(sky(0.6))[1].cover).toBeGreaterThan(0.5);
  });

  it("covers more, and passes less, as the sky clouds over", () => {
    const covers = [0.2, 0.5, 0.8, 1].map((cover) => cloudsOver(sky(cover))[1]);

    for (let i = 1; i < covers.length; i++) {
      expect(covers[i].cover).toBeGreaterThan(covers[i - 1].cover);
      expect(covers[i].passes).toBeLessThan(covers[i - 1].passes);
    }
  });
});

describe("the scene's light under cloud", () => {
  const light = (cover: number) =>
    skyFor(60, AIR.haze, AIR.hazeHeight, cloudsOver(sky(cover)));

  it("is a clear sky's with no cloud", () => {
    const clear = skyFor(60, AIR.haze, AIR.hazeHeight);
    const none = light(0);

    expect(none.beam).toBe(1);
    expect(none.under).toBeCloseTo(clear.sky);
    expect(none.scale).toBeCloseTo(clear.scale);
  });

  it("has no beam under a deck, and the camera opened up for what's left", () => {
    const clear = light(0);
    const deck = light(1);

    expect(deck.beam).toBeLessThan(0.05);
    expect(deck.scale).toBeGreaterThan(clear.scale * 1.5);

    // As the scene shows it, a dull day's not much darker than a fine one.
    const fine = clear.level + clear.sky;
    const dull = deck.beam * deck.level + deck.under;

    expect(dull).toBeGreaterThan(fine * 0.6);
    expect(dull).toBeLessThan(fine);
  });

  it("dims evenly as the sky clouds over, with no step where a deck closes", () => {
    const shown: number[] = [];

    for (let cover = 0; cover <= 1.0001; cover += 0.05) {
      const { beam, level, under } = light(cover);

      shown.push(beam * level + under);
    }

    for (let i = 1; i < shown.length; i++) {
      expect(shown[i]).toBeLessThanOrEqual(shown[i - 1] + 1e-9);
      expect(shown[i - 1] - shown[i]).toBeLessThan(shown[0] * 0.08);
    }
  });

  it("lights the ground by day with what gets under the cloud", () => {
    const deck = light(1);

    expect(skylightFor(1, 1, deck.under)).toBeCloseTo(deck.under);

    // By night it's set by hand, whatever the day's light would have been:
    // a clear night's fill, and a little more under a deck.
    expect(skylightFor(0, 0, deck.under)).toBeCloseTo(0.55);
    expect(skylightFor(1, 0, deck.under)).toBeCloseTo(0.85);
  });
});
