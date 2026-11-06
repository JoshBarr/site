// Greater Wellington Regional Council's Hilltop server
// (https://hilltop.gw.govt.nz), no key needed: its rain gauges and weather
// stations. Its times are NZST all year, without saying so.

const SERVER = "https://hilltop.gw.govt.nz/data.hts";

const TIMEOUT = 15_000;

/** Hilltop's query string, spaces as %20: it reads a + as a plus. */
const url = (params: Record<string, string>) =>
  `${SERVER}?${new URLSearchParams(params).toString().replaceAll("+", "%20")}`;

/** Its XML for `params`; throws on what it says is an error. */
export async function hilltop(params: Record<string, string>) {
  const response = await fetch(url({ Service: "Hilltop", ...params }), {
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`hilltop: HTTP ${response.status}`);

  const body = await response.text();
  const error = /<Error>([^<]*)<\/Error>/.exec(body);

  if (error) throw new Error(`hilltop: ${error[1]}`);

  return body;
}

/** XML's escapes in an attribute, as written. */
export const unescape = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/** A Hilltop time, NZST without saying so, as epoch ms. */
const nzst = (time: string) => Date.parse(`${time}+12:00`);

/** Each reading in a series, at epoch ms, as numbers. */
export const readings = (series: string) =>
  [...series.matchAll(/<E><T>([^<]*)<\/T><I1>([^<]*)<\/I1><\/E>/g)].flatMap(
    ([, time, value]) => {
      const at = nzst(time);
      const amount = Number(value);

      return Number.isFinite(at) && Number.isFinite(amount)
        ? [{ at, value: amount }]
        : [];
    }
  );
