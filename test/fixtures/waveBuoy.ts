import { http, HttpResponse } from "msw/http";
import { server } from "../msw";

// GWRC's wave buoys off Baring Head, as Hilltop serves them in its "Tide
// Levels" collection: a measurement a block, among the tide gauges'.

const SERVER = "https://hilltop.gw.govt.nz/data.hts";

export const NORTH = "Wellington Harbour at Baring Head Wave Buoy (North (A))";
export const SOUTH = "Wellington Harbour at Baring Head Wave Buoy (South (B))";

export const HEIGHT = "Significant Wave Height (Hsig)";
export const PERIOD = "Significant Wave Period (Tsig)";
export const DIRECTION = "Wave Direction";

/** Hilltop's time for epoch ms: NZST, without saying so. */
const nzst = (time: number) =>
  new Date(time + 12 * 3600_000).toISOString().slice(0, 19);

/** A site's series of `source`: its values at each of `times` (epoch ms). */
export const series = (
  site: string,
  source: string,
  values: [time: number, value: number][]
) => `<Measurement SiteName="${site}">
<DataSource Name="${source}" NumItems="1">
<TSType>StdSeries</TSType>
<DataType>SimpleTimeSeries</DataType>
<Interpolation>Instant</Interpolation>
<ItemInfo ItemNumber="1">
<ItemName>${source}</ItemName><ItemFormat>F</ItemFormat><Units>m</Units><Format>#.###</Format>
</ItemInfo>
</DataSource>
<Data DateFormat="Calendar" NumItems="1">
${values.map(([time, value]) => `<E><T>${nzst(time)}</T><I1>${value}</I1></E>`).join("\n")}
</Data>
</Measurement>`;

/** A buoy's readings: (when, height m, period s, direction °) each. */
export const buoy = (
  site: string,
  readings: [time: number, height: number, period: number, direction: number][]
) =>
  [
    series(
      site,
      HEIGHT,
      readings.map(([time, height]) => [time, height])
    ),
    series(
      site,
      PERIOD,
      readings.map(([time, , period]) => [time, period])
    ),
    series(
      site,
      DIRECTION,
      readings.map(([time, , , direction]) => [time, direction])
    ),
  ].join("\n");

/** Hilltop answering with these measurements; gives back what it was asked. */
export function tideLevels(measurements: () => string[]) {
  const asked: string[] = [];

  server.use(
    http.get(SERVER, ({ request }) => {
      asked.push(new URL(request.url).search);

      return new HttpResponse(
        `<?xml version="1.0" ?>\n<Hilltop>\n<Agency>GWRC</Agency>\n${measurements().join("\n")}\n</Hilltop>`,
        { headers: { "Content-Type": "text/xml" } }
      );
    })
  );

  return asked;
}
