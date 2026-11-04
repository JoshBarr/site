import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { fetchTraffic } from "../../src/lib/nzta";
import { server } from "../msw";

// NZTA's journeys around the region, read into the speeds the traffic
// layer drives at.

const JOURNEYS =
  "http://trafficnz.info/service/traffic/rest/4/journeys/byregion/9/1";

/** One, or a list: NZTA sends a list of one as just the one. */
type OneOrMany<T> = T | T[];

interface Link {
  linkName: string;
  linkLength: number | string;
  linkSpeed: number;
}

interface Leg {
  direction: string;
  sequenceNumber: number;
  speed: number;
  coverage: number;
  lengths: OneOrMany<Link>;
}

interface Journey {
  name: string;
  legs?: OneOrMany<Leg>;
}

/** NZTA answering with `journey`, as it is in `response`. */
function journeys(journey: OneOrMany<Journey>) {
  const requests: Request[] = [];

  server.use(
    http.get(JOURNEYS, ({ request }) => {
      requests.push(request);

      return HttpResponse.json({ response: { journey } });
    })
  );

  return requests;
}

const link = (
  linkName: string,
  linkLength: number | string,
  linkSpeed: number
): Link => ({
  linkName,
  linkLength,
  linkSpeed,
});

const leg = (
  direction: string,
  sequenceNumber: number,
  speed: number,
  lengths: OneOrMany<Link>,
  coverage = 1
): Leg => ({ direction, sequenceNumber, speed, coverage, lengths });

describe("NZTA's traffic speeds", () => {
  it("keys each leg by road, way and number, and each link by name and length", async () => {
    const requests = journeys([
      {
        name: "SH1",
        legs: [
          leg("I", 10, 74.33, [
            link("Ngauranga To Aotea", 2.1, 81),
            link("Aotea To Terrace", 1.4, 62),
          ]),
          leg("D", 11, 88.6, [link("Terrace To Aotea", 1.4, 90)]),
        ],
      },
      {
        name: "SH2",
        legs: [leg("I", 1, 95, [link("Petone To Ngauranga", 3, 97)])],
      },
    ]);

    expect(await fetchTraffic()).toEqual({
      legs: { "SH1 I 10": 74, "SH1 D 11": 89, "SH2 I 1": 95 },
      links: {
        "Ngauranga To Aotea|2.1": 81,
        "Aotea To Terrace|1.4": 62,
        "Terrace To Aotea|1.4": 90,
        "Petone To Ngauranga|3": 97,
      },
    });

    expect(requests[0].headers.get("accept")).toBe("application/json");
  });

  it("reads one journey, leg or link sent alone, not in a list", async () => {
    journeys({
      name: "SH1",
      legs: leg("I", 10, 74, link("Ngauranga To Aotea", 2.1, 81)),
    });

    expect(await fetchTraffic()).toEqual({
      legs: { "SH1 I 10": 74 },
      links: { "Ngauranga To Aotea|2.1": 81 },
    });
  });

  it("reads a link's length sent as a string as the number it is", async () => {
    journeys([
      {
        name: "SH1",
        legs: [leg("I", 10, 74, [link("Aotea To Terrace", "1.40", 62)])],
      },
    ]);

    expect((await fetchTraffic()).links).toEqual({
      "Aotea To Terrace|1.4": 62,
    });
  });

  it("leaves out other roads, and legs and links without a reading", async () => {
    journeys([
      { name: "SH58", legs: [leg("I", 1, 70, [link("Haywards", 2, 70)])] },
      {
        name: "SH1",
        legs: [
          // No reading on the leg: its links still count.
          leg("I", 10, -1, [link("Ngauranga To Aotea", 2.1, 81)]),
          // A reading, but no coverage.
          leg("I", 11, 60, [link("Aotea To Terrace", 1.4, -1)], 0),
        ],
      },
      // No legs at all.
      { name: "SH2" },
    ]);

    expect(await fetchTraffic()).toEqual({
      legs: {},
      links: { "Ngauranga To Aotea|2.1": 81 },
    });
  });

  describe("fails", () => {
    it("without a single link's speed", async () => {
      journeys([
        {
          name: "SH1",
          legs: [leg("I", 10, 74, [link("Aotea To Terrace", 1.4, -1)])],
        },
      ]);

      await expect(fetchTraffic()).rejects.toThrow("nzta: no links");
    });

    it("when NZTA does", async () => {
      server.use(
        http.get(JOURNEYS, () => new HttpResponse(null, { status: 502 }))
      );

      await expect(fetchTraffic()).rejects.toThrow("nzta: 502");
    });

    it("when it answers with something else", async () => {
      server.use(http.get(JOURNEYS, () => HttpResponse.json({ response: {} })));

      await expect(fetchTraffic()).rejects.toThrow("nzta: unexpected response");
    });
  });
});
