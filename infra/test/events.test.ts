import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../../src/lib/liveRecords";
import { freezeTime, NOW } from "../../test/clock";
import {
  ALDOUS,
  eventfinda,
  PHOENIX,
  sportsdb,
} from "../../test/fixtures/events";
import { LiveTable } from "../poller/table";
import { updateEvents } from "../timetables/events";
import { makeTable } from "./table";

const DAY = 24 * 3600;

let table: ReturnType<typeof makeTable>;

const update = () =>
  Effect.runPromise(
    updateEvents.pipe(Effect.provideService(LiveTable, table.service))
  );

describe("what's on at the venues", () => {
  beforeEach(() => {
    table = makeTable();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("is fetched into an item of its own each day", async () => {
    eventfinda([ALDOUS]);
    sportsdb({ 134475: [PHOENIX] });

    await update();

    expect(table.records(events)).toEqual([
      {
        pk: "events",
        sk: NOW,
        v: 1,
        data: {
          events: [
            expect.objectContaining({ name: "Aldous Harding" }),
            expect.objectContaining({ venue: "stadium", kind: "football" }),
          ],
        },
        expires: NOW / 1000 + 35 * DAY,
      },
    ]);
  });

  it("isn't written when a source fails", async () => {
    eventfinda([], 503);
    sportsdb({});

    await expect(update()).rejects.toHaveProperty(
      "cause.message",
      "eventfinda: HTTP 503"
    );
    expect(table.items()).toEqual([]);
  });
});
