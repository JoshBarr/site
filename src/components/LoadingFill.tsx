import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { firstViewProgress, subscribeFirstViewProgress } from "./scene/loading";

/**
 * The page as a progress bar for the scene's first view: a lighter shade
 * rising from the bottom, with the percentage riding just under its top edge,
 * to rest under the header at 100%; it fades in once the fill's tall enough
 * to hold it. They move by transform, so they glide on even while the scene
 * keeps the main thread busy.
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

  const percent = Math.round(progress * 100);

  // Whether the fill's risen past the percentage's height, so it fits under
  // the edge.
  const edge = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(false);

  useEffect(() => {
    const el = edge.current;
    const scene = el?.parentElement;

    if (!el || !scene) return;

    setRoom(progress * scene.clientHeight >= el.offsetHeight);
  }, [progress]);

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
      <div
        ref={edge}
        className={`hero__loading-edge container${room ? " hero__loading-edge--room" : ""}`}
      >
        <span className="hero__loading-count">{percent}%</span>
      </div>
    </div>
  );
};
