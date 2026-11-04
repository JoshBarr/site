import { openZip, type RemoteZip, zipCsv } from "./remoteZip";

// The Wellington Cable Car's timetable, from Metlink's static GTFS feed
// (https://opendata.metlink.org.nz). Its realtime feeds have nothing for
// the cable car, but its two cars are tied to one cable and run to the
// timetable, so the scene runs them from it. The feed's a 12 MB zip, so
// only the files and rows wanted are read out of it (./remoteZip.ts), and
// only when its ETag says it's a new one.

export const GTFS_URL =
  "https://static.opendata.metlink.org.nz/v1/gtfs/full.zip";

/** GTFS's route type for a cable tram: the cable car's the region's only one. */
const CABLE_TRAM = "5";

export interface CableCarTrip {
  service: string;
  /** 1 down to Lambton Quay, 0 up to Kelburn. */
  direction: number;
  /** Each stop in order, and when it's there: seconds after its day's start. */
  stops: [string, number][];
}

export interface Timetable {
  /** The feed's ETag: it's fetched again only once that changes. */
  etag: string;
  /** The first and last days the feed covers, YYYYMMDD. */
  start: string;
  end: string;
  /** The days each service runs, YYYYMMDD. */
  services: Record<string, string[]>;
  trips: CableCarTrip[];
}

/** GTFS's HH:MM:SS, which runs past 24:00 for trips after midnight. */
function seconds(time: string) {
  const [h, m, s] = time.split(":").map(Number);

  return h * 3600 + m * 60 + s;
}

const toDate = (day: string) =>
  new Date(
    Date.UTC(
      Number(day.slice(0, 4)),
      Number(day.slice(4, 6)) - 1,
      Number(day.slice(6))
    )
  );

const toDay = (date: Date) =>
  date.toISOString().slice(0, 10).replaceAll("-", "");

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** The days each of `wanted` runs, from calendar.txt and calendar_dates.txt. */
async function serviceDays(zip: RemoteZip, wanted: Set<string>) {
  const days = new Map<string, Set<string>>(
    [...wanted].map((service) => [service, new Set()])
  );

  const where = { column: "service_id", values: wanted };

  for await (const row of zipCsv(zip, "calendar.txt", where)) {
    const end = toDate(row.end_date);

    for (
      let d = toDate(row.start_date);
      d <= end;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      if (row[WEEKDAYS[d.getUTCDay()]] === "1") {
        days.get(row.service_id)!.add(toDay(d));
      }
    }
  }

  // 1 adds a day, 2 takes it away.
  for await (const row of zipCsv(zip, "calendar_dates.txt", where)) {
    if (row.exception_type === "1") days.get(row.service_id)!.add(row.date);
    else days.get(row.service_id)!.delete(row.date);
  }

  return Object.fromEntries(
    [...days].map(([service, dates]) => [service, [...dates].sort()])
  );
}

/**
 * The cable car's timetable from the GTFS feed: null if the feed's ETag is
 * still `etag`, so there's nothing new.
 */
export async function fetchTimetable(
  etag?: string | null
): Promise<Timetable | null> {
  const zip = await openZip(GTFS_URL, etag);

  if (!zip) return null;

  const routes = new Set<string>();

  for await (const row of zipCsv(zip, "routes.txt")) {
    if (row.route_type === CABLE_TRAM) routes.add(row.route_id);
  }

  if (!routes.size) throw new Error("GTFS: no cable car route");

  const trips = new Map<string, CableCarTrip>();

  for await (const row of zipCsv(zip, "trips.txt", {
    column: "route_id",
    values: routes,
  })) {
    trips.set(row.trip_id, {
      service: row.service_id,
      direction: Number(row.direction_id),
      stops: [],
    });
  }

  const sequences = new Map<string, number[]>();

  for await (const row of zipCsv(zip, "stop_times.txt", {
    column: "trip_id",
    values: new Set(trips.keys()),
  })) {
    trips
      .get(row.trip_id)!
      .stops.push([row.stop_id, seconds(row.departure_time)]);
    sequences.set(row.trip_id, [
      ...(sequences.get(row.trip_id) ?? []),
      Number(row.stop_sequence),
    ]);
  }

  // In stop sequence, which stop_times.txt needn't be.
  for (const [id, trip] of trips) {
    const order = sequences.get(id) ?? [];
    trip.stops = trip.stops
      .map((stop, i) => [order[i], stop] as const)
      .sort(([a], [b]) => a - b)
      .map(([, stop]) => stop);
  }

  const running = [...trips.values()].filter(({ stops }) => stops.length > 1);

  const services = await serviceDays(
    zip,
    new Set(running.map((t) => t.service))
  );

  const days = Object.values(services).flat().sort();
  let [start, end] = [days[0], days.at(-1)];

  // Optional in GTFS: without it, as far as the services run.
  if (zip.entries.has("feed_info.txt")) {
    for await (const row of zipCsv(zip, "feed_info.txt")) {
      start = row.feed_start_date || start;
      end = row.feed_end_date || end;
    }
  }

  if (!start || !end) throw new Error("GTFS: the cable car never runs");

  return { etag: zip.etag, start, end, services, trips: running };
}
