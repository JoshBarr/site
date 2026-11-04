import { z } from "zod";
import { readJson } from "./schemas";

// Wellington's public holidays, from Nager.Date: the national ones,
// Mondayised as they're observed, Matariki, and Wellington Anniversary Day.
// The roads are as quiet as a weekend's.

const API = "https://date.nager.at/api/v3/PublicHolidays";

const TIMEOUT = 10_000;

/** Where Nager.Date marks Wellington's own holidays. */
const WELLINGTON = "NZ-WGN";

/** Years Nager.Date answers for. */
export const YEARS: [number, number] = [1976, 2075];

const publicHolidays = z.array(
  z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    global: z.boolean(),
    counties: z.array(z.string()).nullable(),
    types: z.array(z.string()),
  })
);

export interface HolidaysResponse {
  year: number;
  /** Days off in Wellington, "YYYY-MM-DD". */
  dates: string[];
}

/** Wellington's public holidays in `year`. */
export async function fetchHolidays(year: number): Promise<string[]> {
  const response = await fetch(`${API}/${year}/NZ`, {
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`nager.date: HTTP ${response.status}`);

  const holidays = await readJson(response, publicHolidays, "nager.date");

  return holidays
    .filter(
      (h) =>
        h.types.includes("Public") &&
        (h.global || h.counties?.includes(WELLINGTON))
    )
    .map((h) => h.date);
}
