import React, {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { REPLAY } from "../../../lib/replay";
import {
  HOUR,
  type Metric,
  nextDay,
  nzDate,
  nzMidnight,
  SLOT,
  type TimelineDay,
} from "../../../lib/timeline";
import { sceneNow, useSeek } from "../clock";
import { MARGIN, useJump } from "./jump";
import {
  areaPath,
  type Combine,
  extent,
  linePath,
  peak,
  points,
  type SunTimes,
  sunTimes,
  type Turn,
  turns,
  valueAt,
} from "./marks";
import { useTimelineDays } from "./useTimeline";

// Time travel: a drawer at the foot of the scene, a timeline of the last 30
// days as small multiples, one row each, on one time axis. What was out
// (aircraft, ships under way, trains, buses, in the colours of their
// trails), the roads' speed, the tide, the temperature and the rain, with
// daylight and quakes behind and above. Hover for the time and what was
// out then; click to take the scene there. Drag or scroll to go back.

const ZONE = "Pacific/Auckland";
const DAY = 86_400_000;

type Kind = "count" | "line" | "rain";

interface Row {
  metric: Metric;
  label: string;
  /** What it is, on hover. */
  title: string;
  color: string;
  kind: Kind;
  format: (value: number) => string;
}

const count = (value: number) => `${Math.round(value)}`;

/** The rows, top to bottom: vehicles in their trails' colours. */
const ROWS: Row[] = [
  {
    metric: "flights",
    label: "Flights",
    title: "Aircraft in the air",
    color: "#ffcc1a",
    kind: "count",
    format: count,
  },
  {
    metric: "ships",
    label: "Ships",
    title: "Ships under way",
    color: "#59b3ff",
    kind: "count",
    format: count,
  },
  {
    metric: "trains",
    label: "Trains",
    title: "Trains running",
    color: "#e69eff",
    kind: "count",
    format: count,
  },
  {
    metric: "buses",
    label: "Buses",
    title: "Buses on a trip",
    color: "#73ff8c",
    kind: "count",
    format: count,
  },
  {
    metric: "roads",
    label: "Roads",
    title: "Mean speed on State Highways 1 and 2",
    color: "#c9c9c9",
    kind: "line",
    format: (value) => `${Math.round(value)} km/h`,
  },
  {
    metric: "tide",
    label: "Tide",
    title: "The harbour's height above mean sea level",
    color: "#8fc8d8",
    kind: "line",
    format: (value) =>
      `${value < 0 ? "−" : "+"}${Math.abs(value).toFixed(2)} m`,
  },
  {
    metric: "temperature",
    label: "Temp",
    title: "Air temperature",
    color: "#e3a68a",
    kind: "line",
    format: (value) => `${value.toFixed(1)}°`,
  },
  {
    metric: "rain",
    label: "Rain",
    title: "Rain, over the cloud cover",
    color: "#7fa3d6",
    kind: "rain",
    format: (value) => (value < 0.05 ? "dry" : `${value.toFixed(1)} mm/h`),
  },
];

const combineFor = (kind: Kind): Combine => (kind === "rain" ? "max" : "mean");

const HEADER = 38;

/** Above the rows, for quakes. */
const QUAKES = 16;
const ROW = 20;

/** Each row's data band, inside it. */
const BAND_TOP = 3;
const BAND = ROW - 5;
const ROWS_BOTTOM = QUAKES + ROWS.length * ROW;
const AXIS = 30;
const PLOT = ROWS_BOTTOM + AXIS;

/** The drawer's height, px: what's above it moves up by this when it opens. */
export const PANEL_HEIGHT = HEADER + PLOT + 6;

/** The tab it's opened by, px. */
export const TAB_HEIGHT = 30;

const LABELS = 64;
const VALUES = 76;

const ZOOMS = [
  { days: 1, label: "Day", short: "1d" },
  { days: 3, label: "3 days", short: "3d" },
  { days: 7, label: "Week", short: "7d" },
  { days: 30, label: "Month", short: "30d" },
];

/** A phone: no values column, and shorter words. */
const NARROW = "(max-width: 640px)";

function subscribeNarrow(listener: () => void) {
  const query = matchMedia(NARROW);

  query.addEventListener("change", listener);

  return () => query.removeEventListener("change", listener);
}

const useNarrow = () =>
  useSyncExternalStore(
    subscribeNarrow,
    () => matchMedia(NARROW).matches,
    () => false
  );

/** Slots per point, of these: so each point's at least MIN_POINT wide. */
const STEPS = [1, 2, 3, 6, 12, 24, 36, 72];
const MIN_POINT = 2;

/** Ink, never a series' colour. */
const INK = "rgba(255, 255, 255, 0.86)";
const MUTED = "rgba(255, 255, 255, 0.55)";
const FAINT = "rgba(255, 255, 255, 0.3)";
const SURFACE = "rgba(14, 14, 14, 0.86)";
const QUAKE = "#ff8a6b";

const hourly = new Intl.DateTimeFormat("en-NZ", {
  timeZone: ZONE,
  hour: "numeric",
});

const clock = new Intl.DateTimeFormat("en-NZ", {
  timeZone: ZONE,
  hour: "numeric",
  minute: "2-digit",
});

const dated = new Intl.DateTimeFormat("en-NZ", {
  timeZone: ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
});

const dayOfMonth = new Intl.DateTimeFormat("en-NZ", {
  timeZone: ZONE,
  day: "numeric",
});

const moment = new Intl.DateTimeFormat("en-NZ", {
  timeZone: ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

const shown = new Intl.DateTimeFormat("en-NZ", {
  timeZone: ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** "5pm", or "noon". */
function hourLabel(time: number) {
  const label = hourly.format(time).replace(" ", "");

  return label === "12pm" ? "noon" : label;
}

const tight = (time: number) => clock.format(time).replace(" ", "");

const previousDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);

/** Every NZ date some of which can still be replayed, oldest first. */
function replayable(now: number) {
  const days: string[] = [];

  for (
    let day = nzDate(now);
    nzMidnight(nextDay(day)) >= now - REPLAY;
    day = previousDay(day)
  ) {
    days.unshift(day);
  }

  return days;
}

interface Scale {
  low: number;
  high: number;
}

/** Each row's range over the days loaded: one scale per row, never shared. */
function scalesOf(days: TimelineDay[]) {
  const scales: Partial<Record<Metric, Scale>> = {};

  for (const { metric, kind } of ROWS) {
    let low = Infinity;
    let high = -Infinity;

    for (const day of days) {
      for (const value of day.series[metric] ?? []) {
        if (value === null) continue;
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }

    if (high < low) continue;

    if (kind === "count") {
      scales[metric] = { low: 0, high: Math.max(high, 1) };
    } else if (kind === "rain") {
      scales[metric] = { low: 0, high: Math.max(high, 1) };
    } else {
      const pad = high - low < 1e-6 ? 1 : 0;
      scales[metric] = { low: low - pad, high: high + pad };
    }
  }

  return scales;
}

/** Where `value` sits in row `i`, px from the plot's top. */
const yIn =
  (i: number, { low, high }: Scale) =>
  (value: number) =>
    QUAKES + i * ROW + BAND_TOP + BAND - ((value - low) / (high - low)) * BAND;

/** Text over lines stays legible: a halo of the panel around it. */
const label: React.SVGProps<SVGTextElement> = {
  fontSize: 9,
  fill: MUTED,
  stroke: SURFACE,
  strokeWidth: 3,
  paintOrder: "stroke",
  style: { fontVariantNumeric: "tabular-nums" },
};

interface DayProps {
  start: number;
  end: number;
  /** What was counted, once it's loaded. */
  data: TimelineDay | undefined;
  /** px per ms. */
  px: number;
  /** Slots per point. */
  k: number;
  scales: Partial<Record<Metric, Scale>>;
  sun: SunTimes;
  tides: Turn[];
  /** Days across the view. */
  zoom: number;
  today: boolean;
}

/** One NZ day of the timeline, its own SVG, placed along the axis. */
const DayMarks = memo(function DayMarks({
  start,
  end,
  data,
  px,
  k,
  scales,
  sun,
  tides,
  zoom,
  today,
}: DayProps) {
  const width = (end - start) * px;
  const x = (time: number) => (time - start) * px;
  const dayPx = DAY * px;
  const close = zoom <= 3;

  const step = dayPx >= 900 ? 3 : dayPx >= 300 ? 6 : dayPx >= 140 ? 12 : 0;
  const hours: number[] = [];

  for (let h = step; step && h < 24; h += step) hours.push(start + h * HOUR);

  const dayLabel =
    dayPx >= 80
      ? dated.format(start).replace(",", "")
      : dayOfMonth.format(start);

  return (
    <svg
      width={width}
      height={PLOT}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
      aria-hidden
    >
      {sun.rise !== null && sun.set !== null && (
        <rect
          x={x(sun.rise)}
          y={QUAKES}
          width={x(sun.set) - x(sun.rise)}
          height={ROWS_BOTTOM - QUAKES}
          fill="rgba(255, 255, 255, 0.045)"
        />
      )}

      {hours.map((time) => (
        <line
          key={time}
          x1={x(time)}
          x2={x(time)}
          y1={QUAKES}
          y2={ROWS_BOTTOM + 3}
          stroke="rgba(255, 255, 255, 0.1)"
          strokeDasharray="2 3"
        />
      ))}

      <line
        x1={0.5}
        x2={0.5}
        y1={QUAKES - 4}
        y2={PLOT - 2}
        stroke="rgba(255, 255, 255, 0.25)"
      />

      {data &&
        ROWS.map(({ metric, color, kind }, i) => {
          const scale = scales[metric];

          if (!scale) return null;

          const found = points(data, metric, k, combineFor(kind));
          const y = yIn(i, scale);
          const base = QUAKES + i * ROW + BAND_TOP + BAND;

          if (kind === "rain") {
            const cloud = points(data, "cloud", k, "mean");
            const cloudY = yIn(i, { low: 0, high: 1 });
            const barWidth = Math.max(1, k * SLOT * px - 1);

            return (
              <g key={metric}>
                <path
                  d={areaPath(cloud, x, cloudY, base)}
                  fill="rgba(255, 255, 255, 0.09)"
                />
                {found.map(({ time, value }) =>
                  value !== null && value >= 0.05 ? (
                    <rect
                      key={time}
                      x={x(time) - barWidth / 2}
                      y={y(value)}
                      width={barWidth}
                      height={base - y(value)}
                      fill={color}
                    />
                  ) : null
                )}
              </g>
            );
          }

          const line = (
            <path
              d={linePath(found, x, y)}
              fill="none"
              stroke={color}
              strokeWidth={1.25}
              strokeLinejoin="round"
            />
          );

          if (kind === "count") {
            const top = peak(found);

            return (
              <g key={metric}>
                <path
                  d={areaPath(found, x, y, base)}
                  fill={color}
                  opacity={0.16}
                />
                {line}
                {top?.value && (
                  <>
                    <circle
                      cx={x(top.time)}
                      cy={y(top.value)}
                      r={2}
                      fill={color}
                    />
                    {close && (
                      <text x={x(top.time) + 4} y={y(top.value) + 3} {...label}>
                        {Math.round(top.value)}
                      </text>
                    )}
                  </>
                )}
              </g>
            );
          }

          if (metric === "temperature") {
            const { low, high } = extent(found);

            return (
              <g key={metric}>
                {line}
                {close &&
                  [high, low].map(
                    (point) =>
                      point?.value != null && (
                        <text
                          key={point.time}
                          x={x(point.time) + 3}
                          y={y(point.value) + 3}
                          {...label}
                        >
                          {Math.round(point.value)}°
                        </text>
                      )
                  )}
              </g>
            );
          }

          if (metric === "tide") {
            return (
              <g key={metric}>
                {line}
                {tides.map((turn) => (
                  <g key={turn.time}>
                    <circle
                      cx={x(turn.time)}
                      cy={y(turn.value)}
                      r={1.75}
                      fill={color}
                    />
                    {close && (
                      <text
                        x={x(turn.time) + 4}
                        y={y(turn.value) + 3}
                        {...label}
                      >
                        {turn.kind === "high" ? "H" : "L"}
                        {zoom === 1 && ` ${tight(turn.time)}`}
                      </text>
                    )}
                  </g>
                ))}
              </g>
            );
          }

          return <g key={metric}>{line}</g>;
        })}

      {data?.quakes.map((quake) => (
        <circle
          key={quake.id}
          cx={x(quake.time)}
          cy={QUAKES / 2}
          r={Math.min(6, Math.max(1.5, quake.magnitude - 0.5))}
          fill={QUAKE}
          fillOpacity={0.75}
          style={{ cursor: "help" }}
        >
          <title>
            {`M${quake.magnitude.toFixed(1)}, ${quake.locality}, ${quake.depth} km deep, ${tight(quake.time)}`}
          </title>
        </circle>
      ))}

      {zoom === 1 &&
        sun.rise !== null &&
        sun.set !== null &&
        [
          ["sunrise", sun.rise],
          ["sunset", sun.set],
        ].map(([name, time]) => (
          <text
            key={name}
            x={x(Number(time)) + 3}
            y={QUAKES - 4}
            {...label}
            fill={FAINT}
          >
            {name} {tight(Number(time))}
          </text>
        ))}

      {hours.map((time) => (
        <text
          key={time}
          x={x(time)}
          y={ROWS_BOTTOM + 12}
          textAnchor="middle"
          {...label}
          fill={FAINT}
        >
          {hourLabel(time)}
        </text>
      ))}

      <text
        x={4}
        y={ROWS_BOTTOM + 25}
        {...label}
        fontSize={10.5}
        fill={today ? INK : MUTED}
        fontWeight={today ? 600 : 400}
      >
        {dayLabel}
      </text>
    </svg>
  );
});

const control: React.CSSProperties = {
  padding: "3px 8px",
  border: "1px solid rgba(255, 255, 255, 0.16)",
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

const ClockIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
    <path
      d="M2.6 5.2A6 6 0 1 1 2 8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
    <path d="M1.2 2.6 2.4 5.8 5.5 4.6" fill="currentColor" />
    <path
      d="M8 4.6V8l2.4 1.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

/**
 * The drawer, opened by its tab: `open` and `onOpenChange` are the page's,
 * so it can move what's above out of the way.
 */
export const TimeTravel: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const { replaying } = useSeek();
  const { jump, waiting } = useJump();
  const [now, setNow] = useState<number | null>(null);
  const [zoom, setZoom] = useState(3);
  const [hover, setHover] = useState<number | null>(null);
  const narrow = useNarrow();
  const [view, setView] = useState({ left: 0, width: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  /** The time to keep where it is on screen when the zoom changes. */
  const anchor = useRef<{ time: number; at: number } | null>(null);

  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);

  // The scene's time, by the second.
  useEffect(() => {
    const tick = () => setNow(sceneNow());

    tick();
    const id = setInterval(tick, 1000);

    return () => clearInterval(id);
  }, [replaying]);

  const wallMinute = Math.floor(Date.now() / 60_000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const days = useMemo(() => replayable(Date.now()), [wallMinute]);
  const today = days[days.length - 1];

  const bounds = useMemo(
    () =>
      days.map((day) => {
        const start = nzMidnight(day);
        const end = nzMidnight(nextDay(day));

        return { day, start, end, sun: sunTimes(start, end) };
      }),
    [days]
  );

  const rangeStart = bounds[0].start;
  const rangeEnd = bounds[bounds.length - 1].end;
  const px = view.width / (zoom * DAY);
  const width = (rangeEnd - rangeStart) * px;
  const k = STEPS.find((n) => n * SLOT * px >= MIN_POINT) ?? 72;
  const xOf = (time: number) => (time - rangeStart) * px;

  // The days in view, and one either side.
  const shownFrom = rangeStart + view.left / px - DAY;
  const shownTo = rangeStart + (view.left + view.width) / px + DAY;

  const visible = view.width
    ? bounds.filter(({ start, end }) => end > shownFrom && start < shownTo)
    : [];

  const loaded = useTimelineDays(
    visible.map(({ day }) => day),
    today,
    open
  );

  const scales = useMemo(() => scalesOf([...loaded.values()]), [loaded]);

  // Highs and lows across days, so those near midnight are found.
  const tides = useMemo(() => {
    const all = [...loaded.values()]
      .sort((a, b) => a.start - b.start)
      .flatMap((day) => points(day, "tide", 1, "mean"));

    return turns(all, 3 * HOUR);
  }, [loaded]);

  // Measure the view.
  useLayoutEffect(() => {
    const element = scroller.current;

    if (!element) return;

    const measure = () =>
      setView({ left: element.scrollLeft, width: element.clientWidth });

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const playhead = now ?? Date.now();

  // Open on the scene's time, most of the way across.
  useLayoutEffect(() => {
    const element = scroller.current;

    if (!open || !element || !view.width || placed.current) return;

    placed.current = true;
    element.scrollLeft = xOf(playhead) - view.width * 0.8;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view.width]);

  // Zoom about the scene's time, or the middle if it's out of view.
  useLayoutEffect(() => {
    const element = scroller.current;
    const kept = anchor.current;

    if (!element || !kept) return;

    anchor.current = null;
    element.scrollLeft = (kept.time - rangeStart) * px - kept.at;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [px]);

  const zoomTo = (days: number) => {
    const element = scroller.current;

    if (element && view.width) {
      const at = xOf(playhead) - element.scrollLeft;
      const inView = at >= 0 && at <= view.width;

      anchor.current = inView
        ? { time: playhead, at }
        : {
            time: rangeStart + (element.scrollLeft + view.width / 2) / px,
            at: view.width / 2,
          };
    }

    setZoom(days);
  };

  // A wheel's turn scrolls along the timeline, not the page.
  useEffect(() => {
    const element = scroller.current;

    if (!element) return;

    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      element.scrollLeft += e.deltaY;
    };

    element.addEventListener("wheel", wheel, { passive: false });

    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const onScroll = () => {
    const element = scroller.current;

    if (element) {
      setView({ left: element.scrollLeft, width: element.clientWidth });
    }
  };

  /** The start of the point under `clientX`, no later than now. */
  const timeAt = (clientX: number) => {
    const rect = content.current?.getBoundingClientRect();

    if (!rect || !px) return null;

    const time = rangeStart + (clientX - rect.left) / px;
    const day = bounds.find(({ start, end }) => time >= start && time < end);

    if (!day) return null;

    const bucket = k * SLOT;

    return Math.min(
      day.start + Math.floor((time - day.start) / bucket) * bucket,
      Date.now()
    );
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const element = scroller.current;

    if (!element || e.button !== 0) return;

    drag.current = { x: e.clientX, left: element.scrollLeft, moved: false };

    // Touch scrolls by itself.
    if (e.pointerType === "mouse")
      e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const dragging = drag.current;
    const element = scroller.current;

    if (dragging && element && e.pointerType === "mouse") {
      const dx = e.clientX - dragging.x;

      if (Math.abs(dx) > 4) dragging.moved = true;

      if (dragging.moved) element.scrollLeft = dragging.left - dx;
    }

    setHover(timeAt(e.clientX));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const dragging = drag.current;

    drag.current = null;

    if (!dragging || dragging.moved) return;

    const time = timeAt(e.clientX);

    if (time !== null) jump(time);
  };

  const focus = hover ?? playhead;

  const focusDay = bounds.find(
    ({ start, end }) => focus >= start && focus < end
  );

  const focusData = focusDay && loaded.get(focusDay.day);
  const earliest = Date.now() - REPLAY + MARGIN;

  const marker = (
    time: number,
    style: React.CSSProperties,
    key: string
  ): React.ReactNode => (
    <div
      key={key}
      style={{
        position: "absolute",
        left: xOf(time),
        top: QUAKES - 4,
        height: ROWS_BOTTOM - QUAKES + 8,
        width: 0,
        pointerEvents: "none",
        ...style,
      }}
    />
  );

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: PANEL_HEIGHT,
        transform: open ? "translateY(0)" : `translateY(${PANEL_HEIGHT}px)`,
        transition: "transform 380ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        color: INK,
        font: "12px system-ui, sans-serif",
        userSelect: "none",
      }}
    >
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        style={{
          position: "absolute",
          right: 16,
          bottom: "100%",
          height: TAB_HEIGHT,
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "0 12px",
          border: "none",
          borderRadius: "7px 7px 0 0",
          background: SURFACE,
          backdropFilter: "blur(10px)",
          color: INK,
          font: "12.5px system-ui, sans-serif",
          cursor: "pointer",
        }}
      >
        <ClockIcon />
        <span>Time travel</span>
        {replaying && now !== null && (
          <span style={{ color: MUTED, fontVariantNumeric: "tabular-nums" }}>
            · {moment.format(now)}
          </span>
        )}
      </button>

      <div
        inert={!open}
        style={{
          height: "100%",
          background: SURFACE,
          backdropFilter: "blur(10px)",
          borderTop: "1px solid rgba(255, 255, 255, 0.08)",
        }}
      >
        <div
          style={{
            height: HEADER,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 12px 0 16px",
          }}
        >
          {replaying && now !== null ? (
            <>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {(narrow ? moment : shown).format(now)}
              </span>
              <button type="button" onClick={() => jump(null)} style={control}>
                {narrow ? "Live" : "Back to live"}
              </button>
            </>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "#ff5a4f",
                }}
              />
              Live
            </span>
          )}
          <span
            style={{
              display: narrow && waiting === null ? "none" : "block",
              minWidth: 0,
              color: FAINT,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {waiting !== null
              ? `Going to ${moment.format(waiting)}…`
              : "Click anywhere in the last 30 days to go there"}
          </span>
          <span style={{ flex: 1 }} />
          <div
            role="group"
            aria-label="Zoom"
            style={{ display: "flex", gap: 2 }}
          >
            {ZOOMS.map(({ days: span, label: name, short }) => (
              <button
                key={span}
                type="button"
                aria-pressed={zoom === span}
                onClick={() => zoomTo(span)}
                style={{
                  ...control,
                  border: "none",
                  color: zoom === span ? INK : MUTED,
                  background:
                    zoom === span ? "rgba(255, 255, 255, 0.12)" : "transparent",
                }}
              >
                {narrow ? short : name}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close time travel"
            style={{ ...control, border: "none", fontSize: 14, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", height: PLOT }}>
          <div
            style={{
              width: narrow ? LABELS - 12 : LABELS,
              flex: "none",
              position: "relative",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 1,
                left: narrow ? 8 : 16,
                fontSize: 10,
                color: FAINT,
              }}
            >
              Quakes
            </span>
            {ROWS.map(({ metric, label: name, title, color }, i) => (
              <span
                key={metric}
                title={title}
                style={{
                  position: "absolute",
                  top: QUAKES + i * ROW,
                  left: narrow ? 8 : 16,
                  height: ROW,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 11,
                  color: MUTED,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 2,
                    borderRadius: 1,
                    background: color,
                  }}
                />
                {name}
              </span>
            ))}
          </div>

          <div
            ref={scroller}
            onScroll={onScroll}
            style={{
              flex: 1,
              overflowX: "auto",
              overflowY: "hidden",
              scrollbarWidth: "none",
              overscrollBehaviorX: "contain",
            }}
          >
            <div
              ref={content}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => (drag.current = null)}
              onPointerLeave={() => setHover(null)}
              style={{
                position: "relative",
                width,
                height: PLOT,
                cursor: "pointer",
                touchAction: "pan-x",
              }}
            >
              {visible.map(({ day, start, end, sun }) => (
                <div
                  key={day}
                  style={{
                    position: "absolute",
                    left: xOf(start),
                    top: 0,
                    width: (end - start) * px,
                    height: PLOT,
                  }}
                >
                  <DayMarks
                    start={start}
                    end={end}
                    data={loaded.get(day)}
                    px={px}
                    k={k}
                    scales={scales}
                    sun={sun}
                    tides={tides.filter(
                      ({ time }) => time >= start && time < end
                    )}
                    zoom={zoom}
                    today={day === today}
                  />
                </div>
              ))}

              {/* Too long ago to replay: the logs are gone. */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: Math.max(0, xOf(earliest)),
                  height: ROWS_BOTTOM,
                  background:
                    "repeating-linear-gradient(135deg, rgba(0,0,0,0.35) 0 3px, transparent 3px 7px)",
                  pointerEvents: "none",
                }}
              />

              {waiting !== null &&
                marker(
                  waiting,
                  { borderLeft: `1px dashed ${MUTED}` },
                  "waiting"
                )}

              {marker(
                playhead,
                { borderLeft: `1.5px solid ${INK}` },
                "playhead"
              )}
              <div
                style={{
                  position: "absolute",
                  left: xOf(playhead) - 4,
                  top: QUAKES - 9,
                  width: 0,
                  height: 0,
                  borderLeft: "4.5px solid transparent",
                  borderRight: "4.5px solid transparent",
                  borderTop: `5px solid ${INK}`,
                  pointerEvents: "none",
                }}
              />

              {hover !== null && (
                <>
                  {marker(
                    hover,
                    { borderLeft: "1px solid rgba(255, 255, 255, 0.6)" },
                    "hover"
                  )}
                  <div
                    style={{
                      position: "absolute",
                      top: ROWS_BOTTOM + 2,
                      left: Math.min(
                        Math.max(xOf(hover), view.left + 62),
                        view.left + view.width - 62
                      ),
                      transform: "translateX(-50%)",
                      padding: "2px 6px",
                      borderRadius: 3,
                      background: "#262626",
                      color: INK,
                      fontSize: 11,
                      whiteSpace: "nowrap",
                      fontVariantNumeric: "tabular-nums",
                      pointerEvents: "none",
                    }}
                  >
                    {moment.format(hover)}
                  </div>
                </>
              )}
            </div>
          </div>

          <div
            style={{
              display: narrow ? "none" : "block",
              width: VALUES,
              flex: "none",
              position: "relative",
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {ROWS.map(({ metric, kind, format }, i) => {
              const value =
                focusData &&
                valueAt(focusData, metric, focus, k, combineFor(kind));

              return (
                <span
                  key={metric}
                  style={{
                    position: "absolute",
                    top: QUAKES + i * ROW,
                    left: 8,
                    height: ROW,
                    display: "flex",
                    alignItems: "center",
                    color: value == null ? FAINT : INK,
                  }}
                >
                  {value == null ? "–" : format(value)}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
