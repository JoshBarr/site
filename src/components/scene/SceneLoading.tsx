import React, { useEffect, useRef, useState } from "react";
import {
  finishFirstView,
  firstViewProgress,
  loadedShare,
  loadingCount,
  setFirstViewProgress,
  startFirstView,
} from "./loading";

/** How often to look at what's in flight, ms. */
const POLL = 200;

/** Nothing in flight for this long and the first view has arrived, ms. */
const SETTLE = 1000;

/**
 * Progress holds here until the view settles: with nothing left to load,
 * it's still waiting to be sure nothing more is wanted.
 */
const UNSETTLED_PROGRESS = 0.99;

/**
 * Loads must run this long before the spinner shows, and stop for this long
 * before it goes: panning streams tiles in all the time, and most land
 * within a frame or two. ms.
 */
const SHOW = 500;
const HIDE = 300;

export const panel: React.CSSProperties = {
  display: "flex",
  borderRadius: 6,
  background: "rgba(0, 0, 0, 0.55)",
  color: "#eee",
  pointerEvents: "none",
  transition: "opacity 0.6s",
};

export const Spinner: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <circle
      cx="12"
      cy="12"
      r="10"
      fill="none"
      stroke="currentColor"
      strokeOpacity="0.25"
      strokeWidth="2.5"
    />
    <path
      d="M12 2a10 10 0 0 1 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <animateTransform
        attributeName="transform"
        type="rotate"
        from="0 12 12"
        to="360 12 12"
        dur="0.9s"
        repeatCount="indefinite"
      />
    </path>
  </svg>
);

/**
 * A small spinner in the corner while tiles are on their way, the first
 * view's progress (see firstViewProgress), and `onSettled` once it's
 * loaded. `started` is false until the
 * terrain manifest is in and tiles can be asked for; `hidden` keeps the
 * spinner away while the scene is.
 */
export const SceneLoading: React.FC<{
  started: boolean;
  hidden: boolean;
  onSettled?: () => void;
}> = ({ started, hidden, onSettled }) => {
  const [settled, setSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const isStarted = useRef(started);
  const status = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    isStarted.current = started;
  }, [started]);

  useEffect(() => {
    startFirstView();

    // Only once tiles have been in flight is the first view on its way: the
    // renderer can still be starting up with nothing asked for yet.
    let streamed = false;
    let pending = true;
    let changedAt = performance.now();
    let done = false;

    const id = setInterval(() => {
      const now = performance.now();
      const count = loadingCount();
      const loading = count > 0;

      // For scripts/shots, which wait for the layers to be in.
      status.current?.setAttribute("data-loads", String(count));

      if (loading && isStarted.current) streamed = true;

      if (loading !== pending) {
        pending = loading;
        changedAt = now;
      }

      const held = now - changedAt;

      if (streamed && !pending && held >= SETTLE) {
        done = true;
        setSettled(true);
      }

      // What's wanted grows as finer tiles are, so the share can fall back;
      // the progress shown never does.
      if (streamed && !done) {
        setFirstViewProgress(
          Math.max(
            firstViewProgress(),
            Math.min(loadedShare(), UNSETTLED_PROGRESS)
          )
        );
      }

      setBusy((shown) =>
        pending ? shown || held >= SHOW : shown && held < HIDE
      );
    }, POLL);

    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!settled) return;
    finishFirstView();
    onSettled?.();
  }, [settled, onSettled]);

  const shown = busy && !hidden;

  return (
    <div
      ref={status}
      role="status"
      aria-label={shown ? "Loading" : undefined}
      // For scripts/shots: the first view's in.
      data-settled={settled || undefined}
      style={{
        ...panel,
        position: "absolute",
        right: 16,
        bottom: 16,
        padding: 8,
        opacity: shown ? 1 : 0,
      }}
    >
      <Spinner size={16} />
    </div>
  );
};
