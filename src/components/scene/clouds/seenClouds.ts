import { useEffect, useState } from "react";
import type { CloudMap } from "../../../lib/cloudMap";
import { layerUrl, sceneNow, useSeek } from "../clock";
import { switchedOff } from "../stats";
import { arrive } from "../time/jump";
import { sceneShown } from "../visibility";
import { FIELD_SIZE, type SeenClouds } from "./cloudField";

/** /api/clouds is asked every five minutes: there's a scan every ten. */
const POLL = 5 * 60_000;

/** Scans this old are no use, ms: the cloud's moved on. */
const STALE = 2 * 3600_000;

/**
 * ?cloud=80 or ?base=600 try a sky out everywhere, so the satellite's left
 * out; ?off=cloudmap leaves it out to compare.
 */
const overridden = () => {
  const params = new URLSearchParams(location.search);

  return params.has("cloud") || params.has("base") || switchedOff("cloudmap");
};

/** A map's cells, if they're the field's size. */
function cellsOf({ cells }: CloudMap) {
  const bytes = Uint8Array.from(atob(cells), (c) => c.charCodeAt(0));

  return bytes.length === FIELD_SIZE * FIELD_SIZE ? bytes : null;
}

/**
 * Where Himawari saw cloud at the scene's time (../clock.ts), asked for
 * again as it runs on and when it's set: null until it's heard from, if the
 * scan's old, or with the sky overridden.
 */
export function useSeenClouds(): SeenClouds | null {
  const seek = useSeek();
  const [seen, setSeen] = useState<SeenClouds | null>(null);

  useEffect(() => {
    if (overridden()) return;

    const arrived = arrive();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let asked = false;
    // When the scan shown was: the same again isn't news.
    let shown: number | null = null;

    const poll = async () => {
      if (sceneShown() || !asked) {
        const url = layerUrl("/api/clouds", 60_000);

        asked = true;

        try {
          const response = url ? await fetch(url) : null;

          const latest: CloudMap | null = response?.ok
            ? await response.json()
            : null;

          if (!stopped && latest && latest.time !== shown) {
            shown = latest.time;
            const cells = cellsOf(latest);

            setSeen(
              cells && sceneNow() - latest.time < STALE
                ? { time: latest.time, cells }
                : null
            );
          }
        } catch (e) {
          console.error("[clouds]", e);
        }

        arrived();
      }

      if (!stopped) timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      arrived();
      clearTimeout(timer);
    };
  }, [seek]);

  return seen;
}
