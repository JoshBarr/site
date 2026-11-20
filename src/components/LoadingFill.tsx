import React, { useSyncExternalStore } from "react";
import { firstViewProgress, subscribeFirstViewProgress } from "./scene/loading";

/**
 * The page as a progress bar for the scene's first view: a lighter shade
 * rising from the bottom. It moves by transform, so it glides on even while
 * the scene keeps the main thread busy. The percentage is in the intro's
 * heading.
 */
export const LoadingFill: React.FC<{
  /** Fades it out. */
  hidden: boolean;
}> = ({ hidden }) => {
  const progress = useSyncExternalStore(
    subscribeFirstViewProgress,
    firstViewProgress,
    () => 0
  );

  return (
    <div
      className={`hero__loading${hidden ? " hero__loading--hidden" : ""}`}
      role="progressbar"
      aria-label="Loading the scene"
      aria-valuenow={Math.round(progress * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      // SAFETY: React's style type lists no custom properties, but passes
      // "--" names through to the element as they are.
      style={{ "--rest": 1 - progress } as React.CSSProperties}
    >
      <div className="hero__loading-fill" />
    </div>
  );
};
