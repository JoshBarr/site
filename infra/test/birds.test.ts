import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { birds, flocks } from "../../src/lib/liveRecords";
import { nzTime } from "../../src/lib/nzClock";
import { toNztm } from "../../src/lib/nztm";
import { ago, freezeTime, NOW } from "../../test/clock";
import {
  asked,
  checklist,
  ebird,
  GARDEN,
  listed,
  MASTERTON,
  OWHIRO,
  PLIMMERTON,
} from "../../test/fixtures/ebird";
import { LiveTable } from "../poller/table";
import { updateBirds } from "../timetables/birds";
import { makeTable } from "./table";

const DAY = 24 * 3600;

let table: ReturnType<typeof makeTable>;

const update = () =>
  Effect.runPromise(
    updateBirds.pipe(Effect.provideService(LiveTable, table.service))
  );

/** A gull count on the south coast, a tern roost up the coast. */
const GULLS = checklist("S1", "2026-11-01 12:28", [
  ["kelgul", 110],
  ["silgul2", 100],
]);

const TERNS = checklist(
  "S2",
  "2026-11-02 11:24",
  [
    ["whfter1", 100],
    ["kelgul", 100],
  ],
  { protocolId: "P21", effortDistanceKm: undefined }
);

describe("birders' checklists", () => {
  beforeEach(() => {
    table = makeTable();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("are read into an item of their own, those on the map, oldest first", async () => {
    ebird(
      [
        listed("S2", PLIMMERTON),
        listed("S9", MASTERTON),
        listed("S8", OWHIRO, 0),
        listed("S1", OWHIRO),
      ],
      [GULLS, TERNS]
    );

    await update();

    // Masterton's off the map, and an empty one's not worth asking for.
    expect(asked).not.toContain("/v2/product/checklist/view/S9");
    expect(asked).not.toContain("/v2/product/checklist/view/S8");

    expect(table.records(birds)).toEqual([
      {
        pk: "birds",
        sk: NOW,
        v: 1,
        data: {
          checklists: [
            {
              id: "S1",
              group: null,
              at: nzTime("2026-11-01 12:28"),
              timed: true,
              minutes: 90,
              km: 2.1,
              protocol: "traveling",
              position: toNztm(OWHIRO.lat, OWHIRO.lng),
              site: OWHIRO.id,
              place: OWHIRO.name,
              birds: [
                ["kelgul", 110],
                ["silgul2", 100],
              ],
            },
            expect.objectContaining({
              id: "S2",
              protocol: "stationary",
              km: null,
              place: PLIMMERTON.name,
            }),
          ],
          checked: ["S1", "S2"],
          species: {
            kelgul: {
              name: "Kelp Gull",
              sci: "Larus dominicanus",
              family: "larida1",
            },
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
          },
        },
        expires: NOW / 1000 + 35 * DAY,
      },
    ]);
  });

  it("keep someone's own spot to ~100 m, unnamed, and birds just seen as present", async () => {
    ebird(
      [listed("S3", GARDEN)],
      [checklist("S3", "2026-11-02", [["tui1", null]], { obsTimeValid: false })]
    );

    await update();

    const [stored] = table.records(birds)[0].data.checklists;

    expect(stored).toMatchObject({
      at: nzTime("2026-11-02 12:00"),
      timed: false,
      position: toNztm(-41.223, 174.822),
      site: null,
      place: null,
      birds: [["tui1", null]],
    });
  });

  it("keep a group's checklist once, however many of them sent it in", async () => {
    ebird(
      [listed("S5", OWHIRO), listed("S4", OWHIRO)],
      [
        checklist("S4", "2026-11-02 09:00", [["flushe1", 165]], {
          groupId: "G1",
        }),
        checklist("S5", "2026-11-02 09:00", [["flushe1", 165]], {
          groupId: "G1",
        }),
      ]
    );

    await update();

    const { data } = table.records(birds)[0];

    expect(data.checklists.map((c) => [c.id, c.group])).toEqual([["S4", "G1"]]);
    expect(data.checked).toEqual(["S4", "S5"]);
  });

  it("aren't read again, nor a group's once kept", async () => {
    table.seed(
      birds,
      ago(3 * 3600),
      {
        checklists: [
          {
            id: "S4",
            group: "G1",
            at: ago(6 * 3600),
            timed: true,
            minutes: 60,
            km: 1,
            protocol: "traveling",
            position: toNztm(OWHIRO.lat, OWHIRO.lng),
            site: OWHIRO.id,
            place: OWHIRO.name,
            birds: [["flushe1", 165]],
          },
        ],
        checked: ["S4", "S1"],
        species: {},
      },
      ago(3 * 3600)
    );

    ebird(
      [listed("S6", OWHIRO), listed("S4", OWHIRO), listed("S1", OWHIRO)],
      [
        GULLS,
        checklist("S6", "2026-11-02 09:00", [["flushe1", 165]], {
          groupId: "G1",
        }),
      ]
    );

    await update();

    expect(asked).toEqual([
      "/v2/product/lists/NZ-WGN?maxResults=200",
      "/v2/product/checklist/view/S6",
    ]);

    const records = table.records(birds);

    expect(records).toHaveLength(2);
    expect(records[1].data).toEqual({
      checklists: [],
      checked: ["S6"],
      species: {},
    });
  });

  it("aren't written when there's nothing new", async () => {
    ebird([listed("S9", MASTERTON)], []);

    await update();

    expect(table.records(birds)).toEqual([]);
  });

  it("are summed up into where the flocks gather, each run", async () => {
    ebird([listed("S2", PLIMMERTON), listed("S1", OWHIRO)], [GULLS, TERNS]);

    await update();

    // Ōwhiro's gulls, a day and a bit before NOW, first: the most birds.
    expect(table.records(flocks)).toEqual([
      {
        pk: "flocks",
        sk: NOW,
        v: 1,
        data: {
          sites: [
            expect.objectContaining({ kind: "gull", size: 210, seen: 1 }),
            expect.objectContaining({ kind: "tern", size: 100 }),
            expect.objectContaining({ kind: "gull", size: 100 }),
          ],
          species: {
            kelgul: {
              name: "Kelp Gull",
              sci: "Larus dominicanus",
              kind: "gull",
            },
            silgul2: expect.objectContaining({ kind: "gull" }),
            whfter1: expect.objectContaining({ kind: "tern" }),
          },
        },
        expires: NOW / 1000 + 35 * DAY,
      },
    ]);

    // Three hours on, nothing new: summed up again, a little fainter.
    freezeTime(NOW + 3 * 3_600_000);
    ebird([listed("S2", PLIMMERTON), listed("S1", OWHIRO)], [GULLS, TERNS]);

    await update();

    const [first, second] = table.records(flocks);

    expect(table.records(birds)).toHaveLength(1);
    expect(second.sk).toBe(NOW + 3 * 3_600_000);
    expect(second.data.sites[0].weight).toBeLessThan(
      first.data.sites[0].weight
    );
  });

  it("leave one that can't be read for next time", async () => {
    ebird([listed("S7", OWHIRO), listed("S1", OWHIRO)], [GULLS]);

    await update();

    const { data } = table.records(birds)[0];

    expect(data.checked).toEqual(["S1"]);
    expect(data.checklists.map((c) => c.id)).toEqual(["S1"]);
  });

  it("aren't written when eBird's down", async () => {
    ebird([], [], 503);

    await expect(update()).rejects.toHaveProperty(
      "cause.message",
      "ebird: HTTP 503"
    );
    expect(table.items()).toEqual([]);
  });

  it("aren't written when none of them can be read", async () => {
    ebird([listed("S7", OWHIRO)], []);

    await expect(update()).rejects.toHaveProperty(
      "cause.message",
      "ebird: HTTP 404"
    );
    expect(table.items()).toEqual([]);
  });
});
