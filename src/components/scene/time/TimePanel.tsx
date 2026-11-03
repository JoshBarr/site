import React, { useEffect, useRef, useState } from "react";
import { REPLAY } from "../../../lib/replay";
import { sceneNow, setSceneTime, useSeek } from "../clock";

const ZONE = "Pacific/Auckland";

/** `time` as NZ wall-clock time, as a datetime-local input takes it. */
function toInput(time: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(time)
      .map(({ type, value }) => [type, value])
  );

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** A datetime-local input's NZ wall-clock time as epoch ms; null if it isn't one. */
function fromInput(value: string) {
  // Date.parse makes something of almost anything, "" included.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) return null;

  const wall = Date.parse(`${value}:00Z`);

  // Back by NZ's offset from UTC then: twice, in case it's a daylight
  // saving change away.
  let time = wall;

  for (let i = 0; i < 2; i++) {
    time = wall - (Date.parse(`${toInput(time)}:00Z`) - time);
  }

  return time;
}

const shown = new Intl.DateTimeFormat("en-NZ", {
  timeZone: ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

/** A picked time waits until the input's been left alone this long, ms. */
const SETTLE = 1000;

/**
 * And for at least this long after the last jump, ms: each one has every
 * layer read its window from the table, uncached.
 */
const GAP = 5000;

/** Picked times are kept this far inside the logs, ms, for the trails. */
const MARGIN = 15 * 60_000;

/** Puts the scene's time in the address as `?t=`, or takes it out for now. */
function setAddress(time: number | null) {
  const url = new URL(location.href);

  if (time === null) url.searchParams.delete("t");
  else url.searchParams.set("t", new Date(time).toISOString());
  // Next keeps its own state in the history entry.
  history.replaceState(history.state, "", url);
}

const control: React.CSSProperties = {
  padding: "4px 8px",
  border: "1px solid rgba(255, 255, 255, 0.18)",
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

/**
 * Pick a time in the last 30 days, NZ time, and the scene replays from
 * then: traffic, weather and the sun as they were. Live goes back to now.
 */
export const TimePanel: React.FC<{ style?: React.CSSProperties }> = ({
  style,
}) => {
  const { replaying } = useSeek();
  const [draft, setDraft] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const lastJump = useRef(0);

  // The scene's time, by the second.
  useEffect(() => {
    const tick = () => setNow(sceneNow());

    tick();
    const id = setInterval(tick, 1000);

    return () => clearInterval(id);
  }, [replaying]);

  // Jump once the draft's settled, and not too soon after the last.
  useEffect(() => {
    if (draft === null) return;

    const wait = Math.max(SETTLE, lastJump.current + GAP - Date.now());

    const id = setTimeout(() => {
      const picked = fromInput(draft);

      setDraft(null);

      if (picked === null) return;

      const wall = Date.now();
      lastJump.current = wall;

      if (picked >= wall) {
        setSceneTime(null);
        setAddress(null);
      } else {
        const time = Math.max(picked, wall - REPLAY + MARGIN);
        setSceneTime(time);
        setAddress(time);
      }
    }, wait);

    return () => clearTimeout(id);
  }, [draft]);

  const goLive = () => {
    setDraft(null);
    lastJump.current = Date.now();
    setSceneTime(null);
    setAddress(null);
  };

  if (now === null) return null;

  const wall = Date.now();

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
        justifyContent: "flex-end",
        maxWidth: "calc(100% - 32px)",
        padding: "6px 8px",
        borderRadius: 6,
        background: "rgba(0, 0, 0, 0.55)",
        color: "#eee",
        font: "13px system-ui, sans-serif",
        userSelect: "none",
        ...style,
      }}
    >
      <span
        style={{
          padding: "0 4px",
          fontVariantNumeric: "tabular-nums",
          opacity: replaying ? 1 : 0.7,
        }}
      >
        {replaying ? shown.format(now) : "Live"}
      </span>
      <input
        type="datetime-local"
        value={draft ?? toInput(now)}
        min={toInput(wall - REPLAY + MARGIN)}
        max={toInput(wall)}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Replay from, NZ time"
        title="Replay from, NZ time"
        style={{ ...control, colorScheme: "dark", cursor: "text" }}
      />
      {replaying && (
        <button type="button" onClick={goLive} style={control}>
          Live
        </button>
      )}
    </div>
  );
};
