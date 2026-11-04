import { http, HttpResponse } from "msw/http";
import type { Positions } from "../../src/lib/positions";
import { NOW } from "../clock";
import { server } from "../msw";

// What the AWS poller publishes to S3, served where LIVE_POSITIONS_URL says
// (see vitest.config.mts).

const URL = "https://live.test/live/positions.json";

/** Nothing heard from anything. */
const nothing: Positions = {
  v: 1,
  time: NOW,
  trains: [],
  buses: [],
  aircraft: [],
  vessels: [],
  traffic: null,
  weather: null,
  quakes: [],
  tide: null,
};

/** Answers for the positions with `respond`. */
export function positionsAnswer(respond: () => Response) {
  server.use(http.get(URL, respond));
}

/** Publishes `nothing`, with what's given in place of it. */
export const published = (positions: Partial<Positions>) =>
  positionsAnswer(() => HttpResponse.json({ ...nothing, ...positions }));
