import { HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signs } from "../../src/lib/liveRecords";
import * as signsRoute from "../../src/pages/api/signs";
import { ago, freezeTime, NOW } from "../clock";
import { liveTable } from "../fixtures/dynamo";
import { positionsAnswer, published } from "../fixtures/positions";
import { call } from "../next";

// /api/signs: what NZTA's message signs are showing, from what the poller
// published, or from its log in the table.

const shown = {
  messages: { 385: "J'VILLE [jl4]12[nl]WGTN CBD [jl4]19", 67: "" },
};

describe("/api/signs", () => {
  beforeEach(() => {
    freezeTime();
  });

  it("serves the messages published, with when they were fetched", async () => {
    published({ signs: { fetched: ago(90), ...shown } });

    const response = await call(signsRoute);

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=120"
    );
    expect(await response.json()).toEqual({
      time: NOW,
      fetched: ago(90),
      ...shown,
    });
  });

  it("is unavailable until the signs have been read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    published({});

    const response = await call(signsRoute);

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
    expect(await response.json()).toEqual({ error: "signs unavailable" });
  });

  it("is unavailable when what's published can't be had", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    positionsAnswer(() => new HttpResponse(null, { status: 403 }));

    expect((await call(signsRoute)).status).toBe(502);
  });

  it("reads positions published before the signs were polled as none yet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    positionsAnswer(() =>
      HttpResponse.json({
        v: 1,
        time: NOW,
        trains: [],
        buses: [],
        aircraft: [],
        vessels: [],
        traffic: null,
        weather: null,
      })
    );

    expect((await call(signsRoute)).status).toBe(502);
  });

  it("won't replay a time that isn't one", async () => {
    const response = await call(signsRoute, "/?at=yesterday");

    expect(response.status).toBe(400);
  });

  describe("from the table", () => {
    let table: ReturnType<typeof liveTable>;

    beforeEach(() => {
      vi.stubEnv("LIVE_TABLE", "scene-live-test");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
      table = liveTable();
    });

    it("serves the newest messages logged", async () => {
      table.seed(signs, ago(600), { messages: { 385: "" } });
      table.seed(signs, ago(45), shown);

      expect(await (await call(signsRoute)).json()).toEqual({
        time: NOW,
        fetched: ago(45),
        ...shown,
      });
    });

    it("serves what the signs showed then, replaying", async () => {
      const AT = ago(3600);
      const then = { messages: { 385: "CRASH AHEAD[nl]EXPECT DELAYS" } };

      table.seed(signs, ago(3700), then);
      table.seed(signs, ago(45), shown);

      const response = await call(signsRoute, `/?at=${AT}`);

      expect(await response.json()).toEqual({
        time: AT,
        fetched: ago(3700),
        ...then,
      });
    });
  });
});
