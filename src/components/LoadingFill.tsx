import React, { useEffect, useState, useSyncExternalStore } from "react";
import { firstViewProgress, subscribeFirstViewProgress } from "./scene/loading";
import { TypingTime } from "./TypedIntro";

/** How often to move on with the typing, ms; the glide smooths between. */
const TICK = 200;

/** How far through `typing` it is at `now`, 0..1; 0 until it's known. */
function typedShare(typing: TypingTime | null, now: number) {
  if (!typing) return 0;

  const share = (now - typing.from) / (typing.to - typing.from);

  return Math.min(Math.max(share, 0), 1);
}

/**
 * The page as a progress bar for the scene's first view: a lighter shade
 * rising from the bottom, with the percentage riding its top edge until it
 * meets the header. They move by transform, so they glide on even while the
 * scene keeps the main thread busy.
 *
 * The scene shows once it's loaded and the intro's typed, so the bar follows
 * whichever's further behind: it never fills before the words are out.
 */
export const LoadingFill: React.FC<{
  /** Fades it out. */
  hidden: boolean;
  /** The intro's typing, once it's known. */
  typing: TypingTime | null;
}> = ({ hidden, typing }) => {
  const loaded = useSyncExternalStore(
    subscribeFirstViewProgress,
    firstViewProgress,
    () => 0
  );

  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!typing) return;

    let id: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      const time = performance.now();
      setNow(time);

      if (time < typing.to) id = setTimeout(tick, TICK);
    };

    tick();

    return () => clearTimeout(id);
  }, [typing]);

  const progress = Math.min(loaded, typedShare(typing, now));
  const percent = Math.round(progress * 100);

  return (
    <div
      className={`hero__loading${hidden ? " hero__loading--hidden" : ""}`}
      role="progressbar"
      aria-label="Loading the scene"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      // SAFETY: React's style type lists no custom properties, but passes
      // "--" names through to the element as they are.
      style={{ "--rest": 1 - progress } as React.CSSProperties}
    >
      <div className="hero__loading-fill" />
      <div className="hero__loading-edge container">
        <span className="hero__loading-count">{percent}%</span>
      </div>
    </div>
  );
};
