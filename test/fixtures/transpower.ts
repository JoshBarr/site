import { http, HttpResponse } from "msw/http";
import { server } from "../msw";

// Transpower's live data and the Electricity Authority's real-time
// dispatch, as lib/gridFlow.ts asks for them.

const HVDC = "https://www.transpower.co.nz/em6/data/hvdc";
const SUMMARY = "https://www.transpower.co.nz/so/data/live_data_summary";
const DISPATCH = "https://emi.azure-api.net/real-time-dispatch/";

/** The chart's own way with a period's time: not read. */
const stamp = { day: 20, month: 10, year: 2026, hour: 19, minute: 0 };

/**
 * Transpower answering with the link's flow north and south over the last
 * trading periods, MW, the newest (last) for `time`.
 */
export function hvdcAnswer(
  time: number,
  north: (number | null)[],
  south: (number | null)[] = north.map(() => 0)
) {
  server.use(
    http.get(HVDC, () =>
      HttpResponse.json({
        last_import: time / 1000,
        start_date: stamp,
        data: {
          dcn_flow: north.map((mw) => [stamp, mw]),
          dcs_flow: south.map((mw) => [stamp, mw]),
          north_limit: north.map(() => [stamp, 1200]),
          south_limit: north.map(() => [stamp, -600]),
        },
        latest_import_time: "19:00",
      })
    )
  );
}

/** The summary's table, as the page shows it. */
const table = (rows: [string, number][]) =>
  `\n<table class="table table-striped table">\n<tbody>${rows
    .map(
      ([name, mw]) =>
        `<tr class="odd">\n  <td>${name}:</td>\n  <td class="value">${mw} MW</td>\n</tr>`
    )
    .join("")}</tbody>\n</table>\n`;

/** Transpower answering with the islands' load at `datetime`, NZ's clock. */
export function loadAnswer(datetime: string, northIsland: number) {
  server.use(
    http.get(SUMMARY, () =>
      HttpResponse.json({
        content: table([
          ["NZ Total", northIsland + 1914],
          ["NI Total", northIsland],
          ["SI Total", 1914],
        ]),
        datetime,
        time: "as the page words it",
      })
    )
  );
}

/** A point of connection's five minutes, as dispatched at `run` (epoch ms). */
export const dispatched = (
  code: string,
  run: number,
  load: number | null,
  generation: number | null = 0
) => ({
  PointOfConnectionCode: code,
  FiveMinuteIntervalDatetime: "2026-11-02T20:00:00",
  FiveMinuteIntervalNumber: 241,
  // UTC, without saying so.
  RunDateTime: new Date(run).toISOString().replace(".000Z", ""),
  SPDLoadMegawatt: load,
  SPDGenerationMegawatt: generation,
  DollarsPerMegawattHour: 74.1,
});

/**
 * The Electricity Authority answering with `rows`, to the subscription
 * `key` only. Returns the keys it was asked with.
 */
export function dispatchAnswer(
  key: string,
  rows: ReturnType<typeof dispatched>[]
) {
  const asked: (string | null)[] = [];

  server.use(
    http.get(DISPATCH, ({ request }) => {
      const given = request.headers.get("Ocp-Apim-Subscription-Key");
      asked.push(given);

      return given === key
        ? HttpResponse.json(rows)
        : HttpResponse.json(
            { statusCode: 401, message: "Access denied" },
            { status: 401 }
          );
    })
  );

  return asked;
}

/** Each of them down. */
export function gridDown({ hvdc = 503, load = 503 } = {}) {
  server.use(
    http.get(HVDC, () => new HttpResponse(null, { status: hvdc })),
    http.get(SUMMARY, () => new HttpResponse(null, { status: load }))
  );
}
