import { useEffect, useState } from "react";
import { layerUrl, useSeek } from "../../clock";
import { sceneShown } from "../../visibility";
import { STALE } from "../../../../lib/signs";
import type { SignsResponse } from "../../../../lib/signs";
import { arrive } from "../../time/jump";

/** The poller asks NZTA every two minutes; /api/signs is asked each minute. */
const POLL = 60_000;

/**
 * `?vms=TEXT` puts TEXT on every message sign, for looking at them: `|`
 * starts a line and `||` a page (or NZTA's own `[nl]` and `[np]`), `~`
 * sets the rest of a line to the right. Null without it.
 */
export function overrideFromUrl(): string | null {
  const value = new URLSearchParams(location.search).get("vms");

  return (
    value &&
    value
      .replaceAll("||", "[np]")
      .replaceAll("|", "[nl]")
      .replaceAll("~", "[jl4]")
  );
}

/**
 * What NZTA's message signs are showing, by sign id, polled from
 * /api/signs: null until the first answer, or when the last good one's
 * gone stale (the signs then show nothing). At the scene's time
 * (../../clock.ts): setting the clock asks again for then.
 */
export function useSigns() {
  const seek = useSeek();
  const [messages, setMessages] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    const arrived = arrive();
    let known: SignsResponse | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const poll = async () => {
      if (sceneShown() || !known) {
        const url = layerUrl("/api/signs");

        try {
          const response = url ? await fetch(url) : null;

          if (response?.ok) known = await response.json();
        } catch (e) {
          console.error("[signs]", e);
        }

        if (stopped) return;

        setMessages(
          known && known.time - known.fetched < STALE ? known.messages : null
        );
        arrived();
      }

      timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      arrived();
      clearTimeout(timer);
    };
  }, [seek]);

  return messages;
}
