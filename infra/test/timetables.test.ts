import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cableCar } from "../../src/lib/liveRecords";
import { freezeTime, NOW } from "../../test/clock";
import { FEED, gtfsFeed } from "../../test/fixtures/gtfs";
import { LiveTable } from "../poller/table";
import { updateCableCar } from "../timetables/cablecar";
import { makeTable } from "./table";

const DAY = 24 * 3600;

let table: ReturnType<typeof makeTable>;

const update = () =>
  Effect.runPromise(
    updateCableCar.pipe(Effect.provideService(LiveTable, table.service))
  );

/** The 7:30 and 7:40 both ways, and the Saturday 9:00. */
const TRIPS = [
  {
    service: "CCL Weekday",
    direction: 1,
    stops: [
      ["KELB", 27000],
      ["SALA", 27077],
      ["TALA", 27146],
      ["CLIF", 27218],
      ["LAMB", 27300],
    ],
  },
  {
    service: "CCL Weekday",
    direction: 0,
    stops: [
      ["LAMB", 27000],
      ["CLIF", 27081],
      ["TALA", 27153],
      ["SALA", 27222],
      ["KELB", 27300],
    ],
  },
  {
    service: "CCL Weekday",
    direction: 1,
    stops: [
      ["KELB", 27600],
      ["LAMB", 27900],
    ],
  },
  {
    service: "CCL Weekday",
    direction: 0,
    stops: [
      ["LAMB", 27600],
      ["KELB", 27900],
    ],
  },
  {
    service: "CCL Sa",
    direction: 1,
    stops: [
      ["KELB", 32400],
      ["LAMB", 32700],
    ],
  },
];

describe("the cable car's timetable", () => {
  beforeEach(() => {
    table = makeTable();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("is read out of the feed into one item", async () => {
    gtfsFeed(FEED);

    await update();

    expect(table.records(cableCar)).toEqual([
      {
        pk: "cablecar",
        sk: "timetable",
        v: 1,
        data: {
          etag: '"feed-1"',
          start: "20261102",
          end: "20261113",
          services: {
            "CCL Weekday": ["20261102", "20261103", "20261104"],
            "CCL Sa": ["20261107", "20261121"],
          },
          trips: TRIPS,
        },
        expires: NOW / 1000 + 365 * DAY,
      },
    ]);
  });

  it("reads only the zip's directory and the files it needs", async () => {
    const { requests } = gtfsFeed(FEED);

    await update();

    // The tail, then each file's header and its data.
    expect(requests).toHaveLength(1 + 2 * 6);
    expect(requests[0]).toEqual({ range: "bytes=-65557", ifNoneMatch: null });
  });

  it("asks only whether the feed's changed while it hasn't", async () => {
    const { requests } = gtfsFeed(FEED);

    await update();
    const written = table.items();
    requests.length = 0;
    freezeTime(NOW + 3_600_000);

    await update();

    expect(requests).toEqual([
      { range: "bytes=-65557", ifNoneMatch: '"feed-1"' },
    ]);
    expect(table.items()).toEqual(written);
  });

  it("writes over the item when it has", async () => {
    gtfsFeed(FEED);
    await update();

    gtfsFeed(
      {
        ...FEED,
        "calendar_dates.txt": "service_id,date,exception_type\n",
      },
      '"feed-2"'
    );

    await update();

    const [record] = table.records(cableCar);

    expect(table.records(cableCar)).toHaveLength(1);
    expect(record.data.etag).toBe('"feed-2"');
    expect(record.data.services).toEqual({
      "CCL Weekday": [],
      "CCL Sa": ["20261107", "20261114", "20261121"],
    });
  });

  it("fails without a cable car in the feed, writing nothing", async () => {
    gtfsFeed({
      ...FEED,
      "routes.txt": "route_id,route_type\n2,2\n",
    });

    await expect(update()).rejects.toHaveProperty(
      "cause.message",
      "GTFS: no cable car route"
    );
    expect(table.items()).toEqual([]);
  });
});
