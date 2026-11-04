import { useEffect, useState } from "react";
import type { HolidaysResponse } from "../../../lib/holidays";

/** The year in New Zealand at `date`. */
const nzYear = (date: Date) =>
  Number(
    new Intl.DateTimeFormat("en-NZ", {
      timeZone: "Pacific/Auckland",
      year: "numeric",
    }).format(date)
  );

/**
 * Wellington's public holidays in the scene's year, "YYYY-MM-DD", from
 * /api/holidays: null until asked, or if it couldn't say, when traffic
 * goes without. `ready` once asked, answered or not.
 */
export function useHolidays(time: Date) {
  const year = nzYear(time);

  const [state, setState] = useState<{
    year: number;
    dates: ReadonlySet<string> | null;
  } | null>(null);

  useEffect(() => {
    let stopped = false;

    const ask = async () => {
      let dates: ReadonlySet<string> | null = null;

      try {
        const response = await fetch(`/api/holidays?year=${year}`);

        if (response.ok) {
          const answer: HolidaysResponse = await response.json();
          dates = new Set(answer.dates);
        }
      } catch (e) {
        console.error("[holidays]", e);
      }

      if (!stopped) setState({ year, dates });
    };

    ask();

    return () => {
      stopped = true;
    };
  }, [year]);

  return state?.year === year
    ? { holidays: state.dates, ready: true }
    : { holidays: null, ready: false };
}
