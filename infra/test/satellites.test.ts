import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { satellites } from "../../src/lib/liveRecords";
import { freezeTime, NOW } from "../../test/clock";
import { celestrak, HST, ISS } from "../../test/fixtures/celestrak";
import { LiveTable } from "../poller/table";
import { updateSatellites } from "../timetables/satellites";
import { makeTable } from "./table";

const DAY = 24 * 3600;

let table: ReturnType<typeof makeTable>;

const update = () =>
  Effect.runPromise(
    updateSatellites.pipe(Effect.provideService(LiveTable, table.service))
  );

describe("the satellites' orbits", () => {
  beforeEach(() => {
    table = makeTable();
    freezeTime();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("are fetched into an item of their own each day", async () => {
    const { requests } = celestrak();

    await update();
    freezeTime(NOW + DAY * 1000);
    await update();

    expect(requests.map((url) => url.searchParams.get("GROUP"))).toEqual([
      "visual",
      "visual",
    ]);
    expect(table.records(satellites)).toEqual(
      [NOW, NOW + DAY * 1000].map((time) => ({
        pk: "satellites",
        sk: time,
        v: 1,
        // Less what SGP4 doesn't need.
        data: { orbits: [ISS, HST] },
        expires: time / 1000 + 35 * DAY,
      }))
    );
  });

  it("aren't written when CelesTrak fails", async () => {
    celestrak([], 403);

    await expect(update()).rejects.toHaveProperty(
      "cause.message",
      "celestrak: HTTP 403"
    );
    expect(table.items()).toEqual([]);
  });

  it("aren't written when they're not what's expected", async () => {
    celestrak([{ OBJECT_NAME: "ISS (ZARYA)" }]);

    await expect(update()).rejects.toHaveProperty(
      "cause.message",
      expect.stringContaining("celestrak: unexpected response")
    );
    expect(table.items()).toEqual([]);
  });
});
