import type { Bus } from "./buses";
import { toNztm } from "./nztm";
import type { Line, Train } from "./trains";

// Train and bus positions from Metlink's open data API
// (https://opendata.metlink.org.nz), as GTFS Realtime vehicle positions:
// every bus, train and ferry in the region, each unit's GPS fix refreshed
// about every 30 seconds. There's no history, so trails are kept by
// trainStore and busStore.

const API = "https://api.opendata.metlink.org.nz/v1";
const TIMEOUT = 5_000;

/** Metlink's GTFS route ids for the rail lines (route_type 2). */
const LINES: Record<number, Line> = {
  2: "KPL",
  3: "MEL",
  4: "WRL",
  5: "HVL",
  6: "JVL",
};
/**
 * Routes that aren't buses or trains: the Days Bay ferry (on AIS, so it's
 * among the ships already) and the cable car.
 */
const NOT_BUSES = new Set([8, 9]);

interface Entity {
  vehicle: {
    position: { latitude: number; longitude: number; bearing?: number };
    /** Epoch seconds. */
    timestamp: number;
    /** Out of service, there's no trip, or no route in it. */
    trip?: { route_id?: number | string; direction_id?: number };
    vehicle: { id: string };
  };
}

/** Every vehicle reporting. */
async function fetchVehicles(): Promise<Entity["vehicle"][]> {
  const key = process.env.METLINK_API_KEY;
  if (!key) throw new Error("METLINK_API_KEY isn't set");
  const response = await fetch(`${API}/gtfs-rt/vehiclepositions`, {
    headers: { "x-api-key": key, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) {
    throw new Error(`metlink vehiclepositions: HTTP ${response.status}`);
  }
  const { entity } = (await response.json()) as { entity: Entity[] };
  return entity.map(({ vehicle }) => vehicle);
}

/** Where a vehicle is, in NZTM to the decimetre, and when. */
function fix(v: Entity["vehicle"]) {
  const [easting, northing] = toNztm(v.position.latitude, v.position.longitude);
  const position: [number, number] = [
    Math.round(easting * 10) / 10,
    Math.round(northing * 10) / 10,
  ];
  const time = v.timestamp * 1000;
  return {
    id: v.vehicle.id,
    direction: v.trip?.direction_id ?? 0,
    position,
    bearing: v.position.bearing ?? null,
    time,
    trail: [[...position, time] as [number, number, number]],
  };
}

/** Every train in service, without trails. */
export async function fetchTrains(): Promise<Train[]> {
  return (await fetchVehicles()).flatMap((v): Train[] => {
    const line = LINES[Number(v.trip?.route_id)];
    return line ? [{ ...fix(v), line }] : [];
  });
}

/** Every bus on a trip, without trails. */
export async function fetchBuses(): Promise<Bus[]> {
  return (await fetchVehicles()).flatMap((v): Bus[] => {
    const route = v.trip?.route_id;
    if (route === undefined || route === "") return [];
    if (LINES[Number(route)] || NOT_BUSES.has(Number(route))) return [];
    return [{ ...fix(v), route: String(route) }];
  });
}
