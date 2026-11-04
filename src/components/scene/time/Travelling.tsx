import React, { useEffect, useState } from "react";
import { panel } from "../SceneLoading";
import { useTravelling } from "./jump";

/**
 * Kept up this long after the last layer's arrived, ms: a jump that waits
 * its turn has a moment between waiting and setting out, and a cached
 * answer would only flash it.
 */
const HIDE = 400;

/**
 * "Travelling…" over the middle of the map from a pick in the time-travel
 * drawer (or Back to live) until every layer has its first answer from
 * then. `hidden` keeps it away while the scene is.
 */
export const Travelling: React.FC<{ hidden: boolean }> = ({ hidden }) => {
  const travelling = useTravelling();
  const [held, setHeld] = useState(false);

  if (travelling && !held) setHeld(true);

  useEffect(() => {
    if (travelling) return;

    const id = setTimeout(() => setHeld(false), HIDE);

    return () => clearTimeout(id);
  }, [travelling]);

  const shown = held && !hidden;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        role="status"
        style={{
          ...panel,
          alignItems: "center",
          padding: "8px 14px",
          fontFamily: "var(--font-mono), ui-monospace, monospace",
          fontSize: 13,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          opacity: shown ? 1 : 0,
          transition: "opacity 0.25s",
        }}
      >
        {shown && "Travelling…"}
      </div>
    </div>
  );
};
