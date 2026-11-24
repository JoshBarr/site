// New Zealand's wall clock, as feeds that give local times without a zone
// write them.

const nzClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Pacific/Auckland",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** What NZ's clocks read at `time`, as if that were UTC: epoch ms. */
function wallClock(time: number) {
  const part = Object.fromEntries(
    nzClock.formatToParts(time).map(({ type, value }) => [type, value])
  );

  return Date.parse(
    `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}Z`
  );
}

/**
 * When NZ's clocks read `wall` ("2026-11-20 19:50", or with seconds),
 * epoch ms.
 */
export function nzTime(wall: string) {
  const [date, clock] = wall.split(" ");

  const read = Date.parse(
    `${date}T${clock.length === 5 ? `${clock}:00` : clock}Z`
  );

  let time = read;

  // Back by NZ's offset then: twice, in case daylight saving's changed
  // between.
  for (let i = 0; i < 2; i++) time = read - (wallClock(time) - time);

  return time;
}

/** NZ's date at `time`: "2026-11-20". */
export function nzDate(time: number) {
  return new Date(wallClock(time)).toISOString().slice(0, 10);
}
