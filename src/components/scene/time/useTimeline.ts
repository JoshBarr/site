import { useEffect, useMemo, useState } from "react";
import type { TimelineDay } from "../../../lib/timeline";

// The days of the timeline the panel's showing, from /api/timeline: each
// fetched once, past days being done (and cached a while by the CDN), and
// today again each minute while it's wanted.

/** How often today's asked for again, ms: the poller counts each minute. */
const REFRESH = 60_000;

interface Fetched {
  day: TimelineDay | null;
  /** When it was asked for, epoch ms. */
  asked: number;
}

/** Shared by every panel: days don't change once they're over. */
const fetched = new Map<string, Fetched>();
const asking = new Set<string>();

async function fetchDay(day: string) {
  asking.add(day);

  try {
    const response = await fetch(`/api/timeline?day=${day}`);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const timeline: TimelineDay = await response.json();

    fetched.set(day, { day: timeline, asked: Date.now() });
  } catch (e) {
    console.warn(`[timeline] ${day}:`, e);
    // Tried again on the next refresh.
    fetched.set(day, { day: null, asked: Date.now() });
  } finally {
    asking.delete(day);
  }
}

/**
 * The days in `wanted` (NZ dates) fetched so far, by date; `today`'s kept
 * fresh. Nothing's fetched while `active` is false. `settled` once every
 * wanted day's been asked for and answered, or failed.
 */
export function useTimelineDays(
  wanted: string[],
  today: string,
  active: boolean
) {
  const [version, setVersion] = useState(0);
  const key = wanted.join();

  useEffect(() => {
    if (!active) return;

    let live = true;

    const fill = () => {
      const now = Date.now();

      const due = key
        .split(",")
        .filter((day) => day && !asking.has(day))
        .filter((day) => {
          const known = fetched.get(day);

          return (
            !known ||
            ((day === today || !known.day) && now - known.asked > REFRESH)
          );
        });

      for (const day of due) {
        void fetchDay(day).then(() => {
          if (live) setVersion((v) => v + 1);
        });
      }
    };

    fill();
    const id = setInterval(fill, REFRESH);

    return () => {
      live = false;
      clearInterval(id);
    };
  }, [key, today, active]);

  return useMemo(() => {
    const days = new Map<string, TimelineDay>();

    for (const day of key.split(",")) {
      const known = fetched.get(day)?.day;

      if (known) days.set(day, known);
    }

    const settled =
      key !== "" && key.split(",").every((day) => fetched.has(day));

    return { days, settled };
    // A new map each time one's fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
}
