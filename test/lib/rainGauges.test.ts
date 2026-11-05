import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { fetchGaugeSites, fetchRainfall } from "../../src/lib/rainGauges";
import { NOW } from "../clock";
import { server } from "../msw";

// GWRC's rain gauges through Hilltop: where they are, then the tips each
// logged lately, read into how hard it's raining at each.

const SERVER = "https://hilltop.gw.govt.nz/data.hts";

/** Hilltop's time for epoch ms: NZST, without saying so. */
const nzst = (time: number) =>
  new Date(time + 12 * 3600_000).toISOString().slice(0, 19);

/** `minutes` before NOW, as Hilltop writes it. */
const minutesAgo = (minutes: number) => nzst(NOW - minutes * 60_000);

/** Hilltop answering each request with `respond(request)`'s XML. */
function hilltop(respond: (request: URLSearchParams) => string) {
  const asked: string[] = [];

  server.use(
    http.get(SERVER, ({ request }) => {
      const { search, searchParams } = new URL(request.url);
      asked.push(search);

      return new HttpResponse(respond(searchParams), {
        headers: { "Content-Type": "text/xml" },
      });
    })
  );

  return asked;
}

const site = (name: string, at?: [number, number]) =>
  `<Site Name="${name}">\n${
    at ? `<Latitude>${at[0]}</Latitude>\n<Longitude>${at[1]}</Longitude>\n` : ""
  }</Site>`;

const SITES = `<?xml version="1.0" ?>
<HilltopServer>
<Agency>GWRC</Agency>
${site("Wellington at Te Papa", [-41.29030427, 174.78130207])}
${site("Hataitai at Hataitai Park", [-41.307865, 174.79101219])}
${site("Hataitai at Hataitai Park (Backup Logger)", [-41.307865, 174.79101219])}
${site("Ngaio &amp; Crofton", [-41.25371, 174.78491])}
${site("Castlepoint N Trial", [-40.92357549, 176.17164914])}
${site("Harry Test Site")}
</HilltopServer>`;

/** A site's series, as `source`, of (minutes ago, mm) readings. */
const measurement = (
  name: string,
  readings: [number, number][],
  source = "Rainfall"
) => `<Measurement SiteName="${name}">
<DataSource Name="${source}" NumItems="1">
<TSType>StdSeries</TSType>
<Interpolation>Incremental</Interpolation>
<ItemInfo ItemNumber="1"><ItemName>Rainfall</ItemName><Units>mm</Units></ItemInfo>
</DataSource>
<Data DateFormat="Calendar" NumItems="1">
${readings.map(([m, mm]) => `<E><T>${minutesAgo(m)}</T><I1>${mm}</I1></E>`).join("\n")}
</Data>
</Measurement>`;

const data = (...measurements: string[]) =>
  `<?xml version="1.0" ?>\n<Hilltop>\n<Agency>GWRC</Agency>\n${measurements.join("\n")}\n</Hilltop>`;

describe("the rain gauges", () => {
  describe("where they are", () => {
    it("is each on the map with a location, but not a second logger", async () => {
      const asked = hilltop(() => SITES);

      const sites = await fetchGaugeSites();

      expect([...sites.keys()]).toEqual([
        "Wellington at Te Papa",
        "Hataitai at Hataitai Park",
        "Ngaio & Crofton",
      ]);

      // In NZTM, to the metre.
      expect(sites.get("Wellington at Te Papa")).toEqual([1749154, 5427485]);

      expect(asked).toEqual([
        "?Service=Hilltop&Request=SiteList&Measurement=Rainfall&Location=LatLong",
      ]);
    });

    it("fails with none on the map", async () => {
      hilltop(() =>
        SITES.replace(/<Site Name="(?!Castlepoint)[\s\S]*?<\/Site>/g, "")
      );

      await expect(fetchGaugeSites()).rejects.toThrow(
        "hilltop: no rain gauges on the map"
      );
    });

    it("fails when Hilltop says why", async () => {
      hilltop(
        () => "<HilltopServer><Error>No sites found</Error></HilltopServer>"
      );

      await expect(fetchGaugeSites()).rejects.toThrow(
        "hilltop: No sites found"
      );
    });
  });

  describe("how hard it's raining", () => {
    const sites = new Map<string, [number, number]>([
      ["Wellington at Te Papa", [1749154, 5427485]],
      ["Hataitai at Hataitai Park", [1749927, 5425519]],
      ["Ngaio & Crofton", [1749540, 5431542]],
    ]);

    it("is what each fell in the half hour to its newest reading", async () => {
      const asked = hilltop(() =>
        data(
          // 1.5 mm in the half hour to 5 minutes ago: the tip 40 minutes
          // ago is before it.
          measurement("Wellington at Te Papa", [
            [40, 0.5],
            [30, 0],
            [25, 0.5],
            [20, 0.5],
            [10, 0.5],
            [5, 0],
          ]),
          // The backup logger's, at the same site, isn't counted.
          measurement(
            "Wellington at Te Papa",
            [
              [12, 0.5],
              [3, 0.5],
            ],
            "Rainfall Backup"
          ),
          // Dry.
          measurement("Hataitai at Hataitai Park", [
            [20, 0],
            [10, 0],
          ]),
          // Quiet for longer than's fresh.
          measurement("Ngaio &amp; Crofton", [
            [60, 0.2],
            [50, 0.2],
          ]),
          // Off the map.
          measurement("Castlepoint N Trial", [[2, 0.5]])
        )
      );

      expect(await fetchRainfall(sites, NOW)).toEqual({
        time: NOW,
        gauges: [
          { position: [1749154, 5427485], rate: 3 },
          { position: [1749927, 5425519], rate: 0 },
        ],
      });

      expect(asked).toEqual([
        "?Service=Hilltop&Request=GetData&Collection=Rainfall&TimeInterval=PT75M%2Fnow",
      ]);
    });

    it("fails on an HTTP error", async () => {
      server.use(
        http.get(SERVER, () => new HttpResponse(null, { status: 503 }))
      );

      await expect(fetchRainfall(sites, NOW)).rejects.toThrow(
        "hilltop: HTTP 503"
      );
    });
  });
});
