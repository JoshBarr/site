import { useEffect, useState } from "react";
import type { Timetable } from "../../../lib/cablecar";

export type Schedule = Omit<Timetable, "etag">;

/** Asked again after this, ms, for a new one: they're checked daily. */
const REFRESH = 6 * 3_600_000;

/** After a failure, ms. */
const RETRY = 60_000;

/**
 * The cable car's timetable from /api/cablecar: null until it's answered.
 * A failed fetch keeps the last one.
 */
export function useTimetable() {
  const [timetable, setTimetable] = useState<Schedule | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const load = async () => {
      let next = RETRY;

      try {
        const response = await fetch("/api/cablecar");

        if (response.ok) {
          const body: Schedule = await response.json();

          if (stopped) return;
          setTimetable(body);
          next = REFRESH;
        }
      } catch (e) {
        console.error("[cablecar]", e);
      }

      if (!stopped) timer = setTimeout(load, next);
    };

    load();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return timetable;
}
