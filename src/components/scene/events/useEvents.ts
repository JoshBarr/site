import { useEffect, useState } from "react";
import type { VenueEvent } from "../../../lib/events";
import type { EventsResponse } from "../../../pages/api/events";
import { layerUrl, useSeek } from "../clock";
import { arrive } from "../time/jump";

/** Live, asked again after this for the morning's new listings, ms. */
const REFRESH = 3 * 3_600_000;

/** After a failure, ms. */
const RETRY = 60_000;

/** Replays ask for a whole day's: they're fetched daily. */
const DAY = 86_400_000;

/**
 * What's on at the big venues, from /api/events: as fetched last before the
 * scene's time. Empty until it's answered, or when the scene's further back
 * than the logs go; a failed fetch keeps the last.
 */
export function useEvents() {
  const seek = useSeek();
  const [events, setEvents] = useState<VenueEvent[]>([]);

  useEffect(() => {
    const arrived = arrive();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const load = async () => {
      let next = RETRY;
      const url = layerUrl("/api/events", DAY);

      try {
        const response = url ? await fetch(url) : null;

        if (!url) {
          setEvents([]);
          next = REFRESH;
        } else if (response?.ok) {
          const body: EventsResponse = await response.json();

          if (stopped) return;
          setEvents(body.events);
          next = REFRESH;
        }
      } catch (e) {
        console.error("[events]", e);
      }

      arrived();

      if (!stopped) timer = setTimeout(load, next);
    };

    load();

    return () => {
      stopped = true;
      arrived();
      clearTimeout(timer);
    };
  }, [seek]);

  return events;
}
