import { http, HttpResponse } from "msw/http";
import { NOW } from "../clock";
import { server } from "../msw";

// Metlink's GTFS Realtime vehicle positions, as its JSON API sends them.

const VEHICLE_POSITIONS =
  "https://api.opendata.metlink.org.nz/v1/gtfs-rt/vehiclepositions";

interface Vehicle {
  /** Usually a string; now and then Metlink sends a number. */
  id: string | number;
  lat: number;
  lon: number;
  bearing?: number;
  /** Epoch ms; Metlink sends whole seconds. */
  time: number;
  /** Without one, it's out of service. */
  trip?: { route: number | string; direction: number };
}

const vehiclePositions = (vehicles: Vehicle[]) => ({
  header: {
    gtfsRealtimeVersion: "2.0",
    incrementality: 0,
    timestamp: Math.round(NOW / 1000),
  },
  entity: vehicles.map((v, i) => ({
    id: `entity-${i}`,
    vehicle: {
      occupancy_status: 1,
      position: {
        latitude: v.lat,
        longitude: v.lon,
        ...(v.bearing !== undefined && { bearing: v.bearing }),
      },
      timestamp: Math.round(v.time / 1000),
      ...(v.trip && {
        trip: {
          direction_id: v.trip.direction,
          route_id: v.trip.route,
          schedule_relationship: 0,
          start_date: "20261102",
          start_time: "19:40:00",
          trip_id: null,
        },
      }),
      vehicle: { id: v.id },
    },
  })),
});

/** Places along the network, latitude and longitude. */
export const PLACES = {
  lambtonQuay: { lat: -41.2795, lon: 174.7765 },
  courtenayPlace: { lat: -41.2935, lon: 174.7816 },
  wellingtonStation: { lat: -41.2789, lon: 174.7808 },
  petone: { lat: -41.2266, lon: 174.871 },
  /** Beyond the scene's map. */
  masterton: { lat: -40.9511, lon: 175.6586 },
};

/**
 * Answers Metlink's vehicle positions with `respond`. The requests made are
 * in what's returned.
 */
export function metlink(respond: () => Response) {
  const requests: Request[] = [];

  server.use(
    http.get(VEHICLE_POSITIONS, ({ request }) => {
      requests.push(request);

      return respond();
    })
  );

  return requests;
}

export const answer = (vehicles: Vehicle[]) => () =>
  HttpResponse.json(vehiclePositions(vehicles));
