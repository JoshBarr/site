import { describe, expect, it } from "vitest";
import type { BirdSightings } from "../../src/lib/birds";
import { kindOf, summarise } from "../../src/lib/flocks";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-25T00:00:00Z");

type Checklist = BirdSightings["checklists"][number];

const SPECIES: BirdSightings["species"] = {
  kelgul: { name: "Kelp Gull", sci: "Larus dominicanus", family: "larida1" },
  silgul2: {
    name: "Silver Gull",
    sci: "Chroicocephalus novaehollandiae",
    family: "larida1",
  },
  whfter1: {
    name: "White-fronted Tern",
    sci: "Sterna striata",
    family: "larida1",
  },
  flushe1: {
    name: "Fluttering Shearwater",
    sci: "Puffinus gavia",
    family: "procel3",
  },
  tui1: {
    name: "Tui",
    sci: "Prosthemadera novaeseelandiae",
    family: "meliph3",
  },
  nezkak1: {
    name: "New Zealand Kaka",
    sci: "Nestor meridionalis",
    family: "strigo1",
  },
};

/** A stationary count at `position`, `days` ago. */
const count = (
  days: number,
  position: [number, number],
  birds: Checklist["birds"],
  extra: Partial<Checklist> = {}
): Checklist => ({
  id: `S${days}${position.join("")}`,
  group: null,
  at: NOW - days * DAY,
  timed: true,
  minutes: 30,
  km: null,
  protocol: "stationary",
  position,
  site: null,
  place: null,
  birds,
  ...extra,
});

const sightings = (...checklists: Checklist[]): BirdSightings[] => [
  { checklists, checked: checklists.map((c) => c.id), species: SPECIES },
];

const OWHIRO: [number, number] = [1747100, 5421304];

describe("the kind a bird flies as", () => {
  it("goes by its family", () => {
    expect(kindOf(SPECIES.flushe1)).toBe("shearwater");
    expect(kindOf(SPECIES.kelgul)).toBe("gull");
    expect(kindOf(SPECIES.nezkak1)).toBe("parrot");
  });

  it("tells terns from gulls by genus", () => {
    expect(kindOf(SPECIES.whfter1)).toBe("tern");
  });

  it("is other for a family it doesn't know, or a 'bird sp.'", () => {
    expect(kindOf({ sci: "Dodo ineptus", family: "raphid1" })).toBe("other");
    expect(kindOf({ sci: "Passeriformes sp.", family: null })).toBe("other");
  });
});

describe("where the flocks gather", () => {
  it("sums each kind's counts at a spot into a site", () => {
    const { sites, species } = summarise(
      sightings(
        count(0, OWHIRO, [
          ["kelgul", 110],
          ["silgul2", 100],
          ["whfter1", 40],
        ])
      ),
      NOW
    );

    expect(sites).toEqual([
      {
        kind: "gull",
        species: ["kelgul", "silgul2"],
        position: OWHIRO,
        radius: 100,
        size: 210,
        peak: 210,
        weight: 1,
        seen: 1,
        last: NOW,
      },
      expect.objectContaining({ kind: "tern", species: ["whfter1"], size: 40 }),
    ]);
    expect(species).toEqual({
      kelgul: { name: "Kelp Gull", sci: "Larus dominicanus", kind: "gull" },
      silgul2: {
        name: "Silver Gull",
        sci: "Chroicocephalus novaehollandiae",
        kind: "gull",
      },
      whfter1: {
        name: "White-fronted Tern",
        sci: "Sterna striata",
        kind: "tern",
      },
    });
  });

  it("counts a sighting for half as much a week on, the middle drawn to the newer", () => {
    const [site] = summarise(
      sightings(
        count(0, [1747000, 5421000], [["kelgul", 30]]),
        count(7, [1747600, 5421000], [["kelgul", 90]])
      ),
      NOW
    ).sites;

    expect(site.weight).toBe(1.5);
    // (1 × 30 + 0.5 × 90) / 1.5
    expect(site.size).toBe(50);
    expect(site.peak).toBe(90);
    expect(site.seen).toBe(2);
    expect(site.last).toBe(NOW);
    // (1 × 1747000 + 0.5 × 1747600) / 1.5
    expect(site.position).toEqual([1747200, 5421000]);
    // The checklists' scatter about it: √(0.5 × 0.5 × 600² / 1.5²) ≈ 283.
    expect(site.radius).toBe(283);
  });

  it("keeps a kilometre square's apart from the next one's", () => {
    const { sites } = summarise(
      sightings(
        count(0, [1747100, 5421300], [["kelgul", 10]]),
        count(0, [1748100, 5421300], [["kelgul", 10]])
      ),
      NOW
    );

    expect(sites.map((s) => s.position)).toEqual([
      [1747100, 5421300],
      [1748100, 5421300],
    ]);
  });

  it("spreads a walk's birds along it, as far as 3 km", () => {
    const { sites } = summarise(
      sightings(
        count(0, OWHIRO, [["tui1", 2]], { km: 1.2, protocol: "traveling" }),
        count(0, [1755307, 5428000], [["flushe1", 165]], {
          km: 25,
          protocol: "traveling",
        })
      ),
      NOW
    );

    expect(sites.map((s) => [s.kind, s.radius])).toEqual([
      ["shearwater", 3000],
      ["songbird", 600],
    ]);
  });

  it("counts a bird just seen as present as one", () => {
    const [site] = summarise(
      sightings(count(0, OWHIRO, [["tui1", null]])),
      NOW
    ).sites;

    expect(site).toMatchObject({ size: 1, peak: 1 });
  });

  it("leaves out what's a month old, faint, or not yet seen", () => {
    const { sites } = summarise(
      sightings(
        count(31, OWHIRO, [["kelgul", 50]]),
        // 0.5 ** (29 / 7) ≈ 0.057: once, a month ago.
        count(29, [1760000, 5430000], [["kelgul", 50]]),
        count(-1, [1740000, 5430000], [["kelgul", 50]])
      ),
      NOW
    );

    expect(sites).toEqual([]);
  });

  it("puts the biggest, surest flocks first", () => {
    const { sites } = summarise(
      sightings(
        count(0, [1740000, 5430000], [["tui1", 3]]),
        count(0, OWHIRO, [["flushe1", 200]])
      ),
      NOW
    );

    expect(sites.map((s) => s.kind)).toEqual(["shearwater", "songbird"]);
  });
});
