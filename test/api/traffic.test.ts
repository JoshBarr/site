import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as route from "../../src/pages/api/traffic";
import { ago, freezeTime, NOW } from "../clock";
import { server } from "../msw";
import { call } from "../next";
import { redis } from "../redis";
import { afterResponse } from "../vercel";

const NZTA =
  "http://trafficnz.info/service/traffic/rest/4/journeys/byregion/9/1";

const link = (
  linkName: string,
  linkLength: number | string,
  speed: number
) => ({
  linkName,
  linkLength,
  linkSpeed: speed,
  linkSpeedLimit: 100,
  proportion: 0.85,
  timeSeconds: 58.5,
  totalLength: 1.23,
});

/** NZTA's journeys, trimmed, in each of the ways it sends them. */
const journeys = {
  response: {
    journey: [
      {
        name: "SH1",
        legs: [
          {
            name: "Linden to Ngauranga",
            direction: "I",
            sequenceNumber: 10,
            speed: 74.33,
            coverage: 1,
            lengths: [
              link("Atkins Road To Forest Lakes Road", 1.4557, 76),
              // No reading.
              link("Forest Lakes Road To Otaki", 2.2, 0),
            ],
          },
          {
            name: "Ngauranga to Linden",
            direction: "D",
            sequenceNumber: 3,
            // No reading.
            speed: -1,
            coverage: 0,
            // One link, with its length as a string.
            lengths: link("Ngauranga To Aotea", "2.1", 81),
          },
        ],
      },
      {
        name: "SH2",
        // One leg, without links.
        legs: {
          name: "Petone to Melling",
          direction: "I",
          sequenceNumber: 1,
          speed: 88.6,
          coverage: 0.5,
        },
      },
      // Not drawn.
      {
        name: "SH58",
        legs: [
          {
            direction: "I",
            sequenceNumber: 0,
            speed: 60,
            coverage: 1,
            lengths: [link("Haywards To Pauatahanui", 3.1, 60)],
          },
        ],
      },
    ],
  },
};

const speeds = {
  links: {
    "Atkins Road To Forest Lakes Road|1.4557": 76,
    "Ngauranga To Aotea|2.1": 81,
  },
  legs: { "SH1 I 10": 74, "SH2 I 1": 89 },
};

const stored = z.object({
  time: z.number(),
  links: z.record(z.string(), z.number()),
  legs: z.record(z.string(), z.number()),
});

/** Answers NZTA with `respond`, returning the requests made. */
function nzta(respond: () => Response) {
  const requests: Request[] = [];

  server.use(
    http.get(NZTA, ({ request }) => {
      requests.push(request);

      return respond();
    })
  );

  return requests;
}

describe("/api/traffic", () => {
  beforeEach(() => freezeTime());

  describe("without Redis", () => {
    beforeEach(() => vi.stubEnv("UPSTASH_REDIS_REST_URL", ""));

    // Each instance keeps its last fetch, so each test starts a new one.
    const load = async () => {
      vi.resetModules();

      return import("../../src/pages/api/traffic");
    };

    it("serves SH1 and SH2 speeds from NZTA", async () => {
      nzta(() => HttpResponse.json(journeys));

      const response = await call(await load());

      expect(response.status).toBe(200);

      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=30, stale-while-revalidate=60"
      );

      expect(await response.json()).toEqual({
        time: NOW,
        fetched: NOW,
        ...speeds,
      });
    });

    it("reads a lone journey, sent as an object", async () => {
      nzta(() =>
        HttpResponse.json({
          response: { journey: journeys.response.journey[0] },
        })
      );

      const response = await call(await load());
      const { links } = await response.json();

      expect(links).toEqual(speeds.links);
    });

    it("is unavailable when NZTA has no speeds", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      nzta(() =>
        HttpResponse.json({ response: { journey: { name: "SH1", legs: [] } } })
      );

      const response = await call(await load());

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
      expect(await response.json()).toEqual({ error: "traffic unavailable" });
    });

    it("is unavailable when NZTA's answer isn't as expected", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      nzta(() => HttpResponse.json({ journeys: [] }));

      const response = await call(await load());

      expect(response.status).toBe(502);
    });
  });

  describe("with Redis", () => {
    it("serves fresh speeds without asking NZTA", async () => {
      redis.seed("traffic:snapshot", { time: ago(30), ...speeds });
      const requests = nzta(() => HttpResponse.json(journeys));

      const response = await call(route);
      await afterResponse();

      expect(await response.json()).toEqual({
        time: NOW,
        fetched: ago(30),
        ...speeds,
      });

      expect(requests).toHaveLength(0);
    });

    it("serves stale speeds straight away, and refreshes them after", async () => {
      redis.seed("traffic:snapshot", {
        time: ago(90),
        links: { "Ngauranga To Aotea|2.1": 20 },
        legs: {},
      });

      nzta(() => HttpResponse.json(journeys));

      const response = await call(route);

      expect(await response.json()).toEqual({
        time: NOW,
        fetched: ago(90),
        links: { "Ngauranga To Aotea|2.1": 20 },
        legs: {},
      });

      await afterResponse();

      expect(redis.read("traffic:snapshot", stored)).toEqual({
        time: NOW,
        ...speeds,
      });
    });

    it("waits for NZTA when nothing's stored yet", async () => {
      nzta(() => HttpResponse.json(journeys));

      const response = await call(route);

      expect(await response.json()).toEqual({
        time: NOW,
        fetched: NOW,
        ...speeds,
      });

      expect(redis.read("traffic:snapshot", stored)).toEqual({
        time: NOW,
        ...speeds,
      });
    });

    it("doesn't ask NZTA while someone else is", async () => {
      redis.seed("traffic:snapshot", { time: ago(90), ...speeds });
      redis.seed("traffic:lock", 1);
      const requests = nzta(() => HttpResponse.json(journeys));

      const response = await call(route);
      await afterResponse();

      expect(response.status).toBe(200);
      expect(requests).toHaveLength(0);
    });

    it("keeps the stale speeds when the refresh fails", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      redis.seed("traffic:snapshot", { time: ago(90), ...speeds });
      nzta(() => new HttpResponse(null, { status: 504 }));

      const response = await call(route);
      await afterResponse();

      expect(response.status).toBe(200);

      expect(redis.read("traffic:snapshot", stored)).toEqual({
        time: ago(90),
        ...speeds,
      });

      expect(error).toHaveBeenCalledWith(
        "[traffic] refresh failed:",
        expect.any(Error)
      );
    });
  });
});
