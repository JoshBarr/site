import React, { useSyncExternalStore } from "react";
import {
  CATEGORIES,
  Category,
  follow,
  getSnapshot,
  next,
  setCut,
  stop,
  subscribe,
} from "./store";

const NAMES: Record<Category, string> = {
  bus: "Bus",
  train: "Train",
  ship: "Ship",
  plane: "Plane",
};

const button: React.CSSProperties = {
  padding: "4px 10px",
  border: "1px solid rgba(255, 255, 255, 0.18)",
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

/**
 * Pick a kind of vehicle and the camera follows one of them, chosen at
 * random, or click one on the map; Next moves on to another. Cut jumps straight to each instead of
 * flying there. Dragging or zooming the map turns about the one followed;
 * Esc or Stop following hands the camera back.
 */
export const FollowPanel: React.FC<{ style?: React.CSSProperties }> = ({
  style,
}) => {
  const { following, counts, cut } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  );

  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "calc(100% - 32px)",
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
        justifyContent: "center",
        padding: "6px 8px",
        borderRadius: 6,
        background: "rgba(0, 0, 0, 0.55)",
        color: "#eee",
        font: "13px system-ui, sans-serif",
        userSelect: "none",
        ...style,
      }}
    >
      <span style={{ opacity: 0.7, padding: "0 4px" }}>Follow</span>
      {CATEGORIES.map((category) => {
        const active = following?.category === category;

        return (
          <button
            key={category}
            type="button"
            disabled={!counts[category]}
            onClick={() => follow(category)}
            aria-pressed={active}
            style={{
              ...button,
              background: active ? "rgba(255, 255, 255, 0.2)" : "transparent",
              opacity: counts[category] ? 1 : 0.4,
              cursor: counts[category] ? "pointer" : "default",
            }}
          >
            {NAMES[category]}{" "}
            <span style={{ opacity: 0.6 }}>{counts[category]}</span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => setCut(!cut)}
        aria-pressed={cut}
        title="Jump straight to each vehicle instead of flying there"
        style={{
          ...button,
          background: cut ? "rgba(255, 255, 255, 0.2)" : "transparent",
        }}
      >
        Cut
      </button>
      {following && (
        <>
          <span
            style={{
              padding: "0 6px",
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {following.label}
          </span>
          <button type="button" onClick={next} style={button}>
            Next
          </button>
          <button
            type="button"
            onClick={stop}
            title="Back to moving the camera freely (Esc)"
            style={button}
          >
            Stop following
          </button>
        </>
      )}
    </div>
  );
};
