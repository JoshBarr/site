// The rain radar's picture over the map as it's passed about (./radar.ts
// reads it, the scene's rain field falls by it): a grid twice the terrain's
// root across, so showers upwind of the map are known before they drift on
// to it, a kilometre a cell.

/** Cells a side of the grid. */
export const RADAR_SIZE = 128;

/** How far it spans, m, centred on the map's: twice the terrain's root. */
export const RADAR_SPAN = 131072;

/** The hardest rate a cell holds, mm/h: a cloudburst. */
const MOST = 100;

/**
 * A rate in mm/h as a cell's byte, and back: by its square root, so drizzle
 * keeps its steps (a byte's 0.0015 mm/h at the bottom, 0.8 at the top).
 */
export const rateByte = (rate: number) =>
  Math.round(255 * Math.sqrt(Math.min(Math.max(rate, 0), MOST) / MOST));

export const byteRate = (byte: number) => (byte / 255) ** 2 * MOST;

export interface RadarScan {
  /** When RainViewer made the frame, epoch ms: the scan's a few minutes older. */
  time: number;
  /**
   * RADAR_SIZE² bytes, base64: how hard it's raining in each cell
   * (byteRate), row by row from the north, each west to east.
   */
  cells: string;
}

export interface Radar {
  /** The last half hour's scans, oldest first; none if there haven't been. */
  scans: RadarScan[];
}

/** There's a frame this often, ms. */
export const RADAR_FRAME = 10 * 60_000;

/**
 * How long before now the scans served were logged, ms: as far back as a
 * gauge's rate goes.
 */
export const RADAR_KEPT = 35 * 60_000;

/** The scans served: the newest, and enough before it for the half hour. */
const SERVED = 4;

/**
 * The scans to serve at `now` from those logged: each frame once, the last
 * few from the half hour before, oldest first.
 */
export function toRadar(logged: RadarScan[], now: number): Radar {
  const byTime = new Map(
    logged.flatMap((scan) =>
      scan.time <= now && scan.time > now - RADAR_KEPT - RADAR_FRAME
        ? [[scan.time, scan] as const]
        : []
    )
  );

  return {
    scans: [...byTime.values()].sort((a, b) => a.time - b.time).slice(-SERVED),
  };
}
