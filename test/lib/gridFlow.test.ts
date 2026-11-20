import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGridFlow,
  fetchHvdc,
  fetchIslandLoad,
  fetchSites,
  type GridFlow,
  nzTime,
} from "../../src/lib/gridFlow";
import { ago } from "../clock";
import {
  dispatchAnswer,
  dispatched,
  gridDown,
  hvdcAnswer,
  loadAnswer,
} from "../fixtures/transpower";
import { server } from "../msw";

// What the grid's carrying: the HVDC link's transfer and the North
// Island's load from Transpower's live data, and each substation's from
// the Electricity Authority's dispatch, read into megawatts and times.

/** NOW (2026-11-02T07:00:20Z) is 8:00 pm in NZ: the summary's newest. */
const AT_EIGHT = "2026-11-02 20:00";
const EIGHT = Date.parse("2026-11-02T07:00:00Z");

describe("the HVDC link's transfer", () => {
  it("is the newest period's, northward positive", async () => {
    hvdcAnswer(ago(1200), [941, 937, 961.4]);

    expect(await fetchHvdc()).toEqual({ time: ago(1200), mw: 961 });
  });

  it("is negative sending south", async () => {
    hvdcAnswer(ago(1200), [0, 0], [320, 284]);

    expect(await fetchHvdc()).toEqual({ time: ago(1200), mw: -284 });
  });

  it("goes back to the last period measured", async () => {
    hvdcAnswer(ago(1200), [500, 480, null, null]);

    // Two half hours before the newest.
    expect(await fetchHvdc()).toEqual({ time: ago(1200 + 3600), mw: 480 });
  });

  it("isn't known with no period measured", async () => {
    hvdcAnswer(ago(1200), [null]);

    expect(await fetchHvdc()).toBeNull();
  });

  it("fails when Transpower does, or answers otherwise", async () => {
    gridDown();
    await expect(fetchHvdc()).rejects.toThrow("transpower hvdc: HTTP 503");

    server.use(
      http.get("https://www.transpower.co.nz/em6/data/hvdc", () =>
        HttpResponse.json({ data: "moved" })
      )
    );

    await expect(fetchHvdc()).rejects.toThrow(
      "transpower hvdc: unexpected response"
    );
  });
});

describe("NZ's wall clock", () => {
  it("is thirteen hours ahead in summer, twelve in winter", () => {
    expect(nzTime("2026-11-20 19:50")).toBe(Date.parse("2026-11-20T06:50Z"));
    expect(nzTime("2026-06-20 19:50")).toBe(Date.parse("2026-06-20T07:50Z"));
  });

  it("changes over at 2 am, the last Sunday of September", () => {
    expect(nzTime("2026-09-27 01:55")).toBe(Date.parse("2026-09-26T13:55Z"));
    expect(nzTime("2026-09-27 03:05")).toBe(Date.parse("2026-09-26T14:05Z"));
  });
});

describe("the North Island's load", () => {
  it("is read from the page's table, at its time", async () => {
    loadAnswer(AT_EIGHT, 3011);

    expect(await fetchIslandLoad()).toEqual({ time: EIGHT, mw: 3011 });
  });

  it("isn't known if the table's without it", async () => {
    server.use(
      http.get("https://www.transpower.co.nz/so/data/live_data_summary", () =>
        HttpResponse.json({ content: "<table></table>", datetime: AT_EIGHT })
      )
    );

    expect(await fetchIslandLoad()).toBeNull();
  });
});

describe("the substations' loads", () => {
  it("are each site's points of connection summed, at the run's time", async () => {
    const asked = dispatchAnswer("secret", [
      dispatched("CPK0111", ago(90), 21.34),
      dispatched("CPK0331", ago(90), 98.21),
      dispatched("WIL0331", ago(90), 31.5, 42.25),
      dispatched("WWD1102", ago(90), 0, 40.1),
      dispatched("WWD1103", ago(90), 0, 38.6),
      // Not on the map.
      dispatched("OTA2201", ago(90), 310, 0),
      dispatched("BEN2201", ago(90), null, 420),
    ]);

    expect(await fetchSites("secret")).toEqual({
      time: ago(90),
      load: { CPK: 119.6, WIL: 31.5, WWD: 0 },
      generation: { CPK: 0, WIL: 42.3, WWD: 78.7 },
    });

    expect(asked).toEqual(["secret"]);
  });

  it("leave out an older run's, should there be two", async () => {
    dispatchAnswer("secret", [
      dispatched("HAY0331", ago(390), 30),
      dispatched("HAY0331", ago(90), 18),
      dispatched("HAY0111", ago(90), 16),
    ]);

    expect(await fetchSites("secret")).toMatchObject({
      time: ago(90),
      load: { HAY: 34 },
    });
  });

  it("aren't known when none on the map were dispatched", async () => {
    dispatchAnswer("secret", [dispatched("OTA2201", ago(90), 310)]);
    expect(await fetchSites("secret")).toBeNull();

    dispatchAnswer("secret", []);
    expect(await fetchSites("secret")).toBeNull();
  });

  it("fail with a key that's not let in", async () => {
    dispatchAnswer("secret", []);

    await expect(fetchSites("guess")).rejects.toThrow("emi dispatch: HTTP 401");
  });
});

describe("what the grid's carrying", () => {
  const link = { time: ago(1200), mw: 961 };
  const island = { time: EIGHT, mw: 3011 };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("is the link and the island's load, without a key", async () => {
    hvdcAnswer(link.time, [link.mw]);
    loadAnswer(AT_EIGHT, island.mw);
    const asked = dispatchAnswer("secret", []);

    expect(await fetchGridFlow(null)).toEqual({
      hvdc: link,
      northIsland: island,
      sites: null,
    });

    expect(asked).toEqual([]);
  });

  it("has each substation's too, with one", async () => {
    vi.stubEnv("LIVE_EMI_KEY", "secret");
    hvdcAnswer(link.time, [link.mw]);
    loadAnswer(AT_EIGHT, island.mw);
    dispatchAnswer("secret", [dispatched("TKR0331", ago(90), 61.2)]);

    expect(await fetchGridFlow(null)).toEqual({
      hvdc: link,
      northIsland: island,
      sites: { time: ago(90), load: { TKR: 61.2 }, generation: { TKR: 0 } },
    });
  });

  it("is nothing new when none of it's newer than before", async () => {
    const before: GridFlow = { hvdc: link, northIsland: island, sites: null };

    hvdcAnswer(link.time, [link.mw]);
    loadAnswer(AT_EIGHT, island.mw);
    expect(await fetchGridFlow(before)).toBeNull();

    // Five minutes on, the load's moved.
    loadAnswer("2026-11-02 20:05", 2987);

    expect(await fetchGridFlow(before)).toEqual({
      ...before,
      northIsland: { time: EIGHT + 300_000, mw: 2987 },
    });
  });

  it("keeps what couldn't be fetched as it was", async () => {
    const sites = { time: ago(400), load: { TKR: 60 }, generation: {} };
    const before: GridFlow = { hvdc: link, northIsland: null, sites };

    vi.stubEnv("LIVE_EMI_KEY", "revoked");
    gridDown();
    loadAnswer(AT_EIGHT, island.mw);
    dispatchAnswer("secret", []);

    expect(await fetchGridFlow(before)).toEqual({
      hvdc: link,
      northIsland: island,
      sites,
    });

    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("drops the substations once the key's gone", async () => {
    const sites = { time: ago(400), load: { TKR: 60 }, generation: {} };

    hvdcAnswer(link.time, [link.mw]);
    loadAnswer(AT_EIGHT, island.mw);

    expect(
      await fetchGridFlow({ hvdc: link, northIsland: island, sites })
    ).toEqual({ hvdc: link, northIsland: island, sites: null });
  });

  it("fails when nothing could be fetched", async () => {
    gridDown();

    await expect(fetchGridFlow(null)).rejects.toThrow(
      "transpower hvdc: HTTP 503"
    );
  });
});
