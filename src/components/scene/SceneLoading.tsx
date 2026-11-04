import React, { useEffect, useRef, useState } from "react";
import { loadingCount } from "./loading";

/** How often to look at what's in flight, ms. */
const POLL = 200;

/** Nothing in flight for this long and the first view has arrived, ms. */
const SETTLE = 1000;

/**
 * Loads must run this long before the spinner shows, and stop for this long
 * before it goes: panning streams tiles in all the time, and most land
 * within a frame or two. ms.
 */
const SHOW = 500;
const HIDE = 300;

const panel: React.CSSProperties = {
  display: "flex",
  borderRadius: 6,
  background: "rgba(0, 0, 0, 0.55)",
  color: "#eee",
  pointerEvents: "none",
  transition: "opacity 0.6s",
};

const Spinner: React.FC<{ size: number }> = ({ size }) => (
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
 * A small spinner in the corner while tiles are on their way, and
 * `onSettled` once the first view has loaded. `started` is false until the
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

  useEffect(() => {
    isStarted.current = started;
  }, [started]);

  useEffect(() => {
    // Only once tiles have been in flight is the first view on its way: the
    // renderer can still be starting up with nothing asked for yet.
    let streamed = false;
    let pending = true;
    let changedAt = performance.now();

    const id = setInterval(() => {
      const now = performance.now();
      const loading = loadingCount() > 0;

      if (loading && isStarted.current) streamed = true;

      if (loading !== pending) {
        pending = loading;
        changedAt = now;
      }

      const held = now - changedAt;

      if (streamed && !pending && held >= SETTLE) setSettled(true);
      setBusy((shown) =>
        pending ? shown || held >= SHOW : shown && held < HIDE
      );
    }, POLL);

    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (settled) onSettled?.();
  }, [settled, onSettled]);

  const shown = busy && !hidden;

  return (
    <div
      role="status"
      aria-label={shown ? "Loading" : undefined}
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
