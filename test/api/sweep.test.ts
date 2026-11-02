import { HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as route from "../../src/pages/api/flights/sweep";
import { ago, freezeTime } from "../clock";
import { adsb, airspace, ANZ441, QFA163 } from "../fixtures/adsb";
import { call } from "../next";
import { sign } from "../qstash";
import { redis } from "../redis";

const member = z.tuple(
  [z.string()],
  z.union([z.string(), z.number(), z.null()])
);

/** A schedule's empty POST, as QStash sends it. */
const fromQStash = (signature = sign("")) => ({
  method: "POST",
  headers: { "Upstash-Signature": signature },
  body: "",
});

describe("/api/flights/sweep", () => {
  beforeEach(() => freezeTime());

  it("stores what's in the air, and forgets what's too old to draw", async () => {
    redis.seedSortedSet("flights:fixes", [
      // Past the half hour trails go back, with a minute's grace.
      { score: ago(32 * 60), member: ["old"] },
      { score: ago(30 * 60), member: ["kept"] },
    ]);

    adsb(() => HttpResponse.json(airspace([ANZ441, QFA163])));

    const response = await call(route, "/", fromQStash());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: 2 });

    expect(redis.members("flights:fixes", member).map(([hex]) => hex)).toEqual([
      "kept",
      "c81e2c",
      "7c6b2d",
    ]);
  });

  it("checks the signature against the next key, too", async () => {
    adsb(() => HttpResponse.json(airspace([])));

    const response = await call(
      route,
      "/",
      fromQStash(sign("", "next-signing-key"))
    );

    expect(await response.json()).toEqual({ stored: 0 });
  });

  it("turns away requests QStash didn't sign", async () => {
    const requests = adsb(() => HttpResponse.json(airspace([ANZ441])));

    const forged = await call(route, "/", fromQStash(sign("", "guessed")));
    const unsigned = await call(route, "/", { method: "POST", body: "" });

    expect(forged.status).toBe(401);
    expect(unsigned.status).toBe(401);
    expect(await forged.json()).toEqual({ error: "invalid signature" });
    expect(requests.airspace).toHaveLength(0);
  });

  it("turns away a signature for another body", async () => {
    const response = await call(route, "/", {
      ...fromQStash(sign("{}")),
      body: '{"extra":true}',
    });

    expect(response.status).toBe(401);
  });

  it("only takes POSTs", async () => {
    const response = await call(route);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("isn't available without Redis or the signing keys", async () => {
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "");

    const unsigned = await call(route, "/", fromQStash());

    vi.unstubAllEnvs();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");

    const unstored = await call(route, "/", fromQStash());

    expect(unsigned.status).toBe(503);
    expect(unstored.status).toBe(503);
    expect(await unstored.json()).toEqual({ error: "sweep not configured" });
  });

  it("answers OK when adsb.lol fails, so QStash doesn't retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    adsb(() => new HttpResponse(null, { status: 503 }));

    const response = await call(route, "/", fromQStash());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ error: "sweep failed" });
  });
});
