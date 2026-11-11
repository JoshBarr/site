// The fixed views the before/after sheets are shot from: a few set views
// (src/components/scene/shots/shots.ts) across the day and the weather.
// Each is the query string after `/scene?`, less what every shot shares.

/** Times on 2026-11-10, NZDT (UTC+13): sunrise ~05:58, sunset ~20:22. */
const NOON = "2026-11-10T00:00:00Z"; // 13:00
const EVENING = "2026-11-10T06:20:00Z"; // 19:20, the sun ~8° up
const DUSK = "2026-11-10T07:45:00Z"; // 20:45, just under
const TWILIGHT = "2026-11-10T07:32:00Z"; // 20:32, the sun ~2° under
const NIGHT = "2026-11-10T10:30:00Z"; // 23:30

const CLEAR = "cloud=0";
const HALF = "cloud=50";
const OVERCAST = "cloud=100";
const RAIN = "cloud=90&rain=4";

/**
 * No cloud, no rain and 30 km of air, whatever that hour's weather was: the
 * sky and the low sun, without the mist the recorded evening had.
 */
const FINE = "cloud=0&rain=0&vis=30000";

/**
 * Every shot holds the clock (and with it the cloud's drift) and the wind,
 * so two runs differ only by the waves and the cloud's jitter.
 */
const SHARED = "freeze";
const WIND = "wind=8,340";
const GALE = "wind=15,340";

/** [name, shot id, time, weather, wind if not WIND]. */
const LIST = [
  ["overview-noon-clear", "overview", NOON, CLEAR],
  ["overview-noon-half", "overview", NOON, HALF],
  ["overview-noon-overcast", "overview", NOON, OVERCAST],
  ["overview-evening-clear", "overview", EVENING, CLEAR],
  ["overview-dusk-half", "overview", DUSK, HALF],
  ["overview-night-clear", "overview", NIGHT, CLEAR],
  ["harbour-noon-half", "harbour", NOON, HALF],
  ["harbour-evening-clear", "harbour", EVENING, CLEAR],
  ["harbour-noon-rain", "harbour", NOON, RAIN],
  ["waterfront-noon-clear", "waterfront", NOON, CLEAR],
  ["waterfront-evening-half", "waterfront", EVENING, HALF],
  ["waterfront-night-clear", "waterfront", NIGHT, CLEAR],
  ["oriental-bay-noon-half", "oriental-bay", NOON, HALF],
  ["mt-victoria-noon-overcast", "mt-victoria", NOON, OVERCAST],
  ["airport-dusk-overcast", "airport", DUSK, OVERCAST],
  ["west-wind-evening-half", "west-wind", EVENING, HALF],
  // Fine air, for the sky's own light (?sky=) through the evening.
  ["overview-noon-fine", "overview", NOON, FINE],
  ["overview-evening-fine", "overview", EVENING, FINE],
  ["overview-twilight-fine", "overview", TWILIGHT, FINE],
  ["mt-victoria-evening-fine", "mt-victoria", EVENING, FINE],
  // A northerly gale, for the sea's lee calms.
  ["harbour-noon-gale", "harbour", NOON, CLEAR, GALE],
  ["oriental-bay-noon-gale", "oriental-bay", NOON, CLEAR, GALE],
  ["mt-victoria-noon-gale", "mt-victoria", NOON, CLEAR, GALE],
];

export const VIEWS = LIST.map(([name, shot, t, weather, wind = WIND]) => ({
  name,
  query: [`shot=${shot}`, `t=${t}`, weather, wind, SHARED]
    .filter(Boolean)
    .join("&"),
}));
