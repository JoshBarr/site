import * as AWS from "@alchemy.run/aws";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Live } from "../live";
import { logMemory } from "../poller/memory";
import { LiveTable } from "../poller/table";
import { updateBirds } from "./birds";
import { updateCableCar } from "./cablecar";
import { updateEvents } from "./events";
import { updateSatellites } from "./satellites";

// Keeps the timetables the scene runs to in the live table, each morning:
// the cable car's, checking Metlink's GTFS feed for a new one (they're
// published in the small hours of the day they start, the last at 4:05 am,
// and until it's read the scene runs the cars to the old one's same day of
// the week); the visual satellites' orbits, from CelesTrak; and what's on at
// the big venues, from Eventfinda and TheSportsDB. And every three hours,
// birders' checklists from eBird, which come in through the day. Its own
// function, not one of the poller's feeds: reading the feed's stop times
// takes ~15 MB, and the poller runs within a few MB of its 160.

export default class Timetables extends AWS.Lambda.Function<Timetables>()(
  "Timetables",
  {
    main: import.meta.url,
    functionUrl: false,
    architecture: "arm64",
    // Reading the stop times ran at 159 of 160 MB (2026-11-06). Once a day,
    // ~32 s: ~240 GB-s a month at 256 MB, and if every run took its full
    // minute, ~480, of the free 400k (the poller takes ~350k).
    memorySize: 256,
    timeout: Duration.seconds(60),
    // A failed morning is tried again the next.
    eventInvokeConfig: { maximumRetryAttempts: 0, maximumEventAge: "1 hour" },
    logging: { retention: "1 day" },
  },
  Effect.gen(function* () {
    // From the env file at deploy, into the function's environment.
    const eventfindaUser = yield* Config.Redacted("EVENTFINDA_USERNAME");
    const eventfindaPassword = yield* Config.Redacted("EVENTFINDA_PASSWORD");
    const ebirdKey = yield* Config.Redacted("EBIRD_API_KEY");

    const table = yield* Live;

    const live = LiveTable.of({
      putItem: yield* AWS.DynamoDB.PutItem(table),
      query: yield* AWS.DynamoDB.Query(table),
    });

    // As the poller's: told not to retry, since the next morning will.
    const schedule = yield* AWS.Scheduler.ScheduleEventSource;

    yield* schedule(
      {
        id: "Daily",
        expression: "cron(15 5 * * ? *)",
        props: {
          timezone: "Pacific/Auckland",
          retryPolicy: {
            MaximumRetryAttempts: 0,
            MaximumEventAgeInSeconds: 3600,
          },
        },
      },
      // The cable car's then the satellites', one after the other (the
      // cable car's read nearly fills the function), each on its own: one
      // failing leaves the other. The events alongside: a few small pages,
      // mostly waiting out TheSportsDB's rate limit.
      () =>
        Effect.all(
          [
            Effect.all(
              [
                updateCableCar.pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("[cablecar]", cause)
                  )
                ),
                updateSatellites.pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("[satellites]", cause)
                  )
                ),
              ],
              { discard: true }
            ),
            Effect.sync(() => {
              // src/lib looks for its keys in process.env.
              process.env.EVENTFINDA_USERNAME = Redacted.value(eventfindaUser);
              process.env.EVENTFINDA_PASSWORD =
                Redacted.value(eventfindaPassword);
            }).pipe(
              Effect.andThen(updateEvents),
              Effect.catchCause((cause) => Effect.logError("[events]", cause))
            ),
          ],
          { discard: true, concurrency: 2 }
        ).pipe(
          Effect.andThen(logMemory),
          Effect.provideService(LiveTable, live)
        )
    );

    // Birders mostly send theirs in the evening; eBird lists the newest
    // ~200, about a week's. ~25 requests a run, of its 500 an hour.
    yield* schedule(
      {
        id: "Birds",
        expression: "cron(40 */3 * * ? *)",
        props: {
          timezone: "Pacific/Auckland",
          retryPolicy: {
            MaximumRetryAttempts: 0,
            MaximumEventAgeInSeconds: 3600,
          },
        },
      },
      () =>
        Effect.sync(() => {
          process.env.EBIRD_API_KEY = Redacted.value(ebirdKey);
        }).pipe(
          Effect.andThen(updateBirds),
          Effect.catchCause((cause) => Effect.logError("[birds]", cause)),
          Effect.andThen(logMemory),
          Effect.provideService(LiveTable, live)
        )
    );

    return {};
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.DynamoDB.PutItemHttp,
        AWS.DynamoDB.QueryHttp,
        AWS.Lambda.ScheduleEventSource
      )
    )
  )
) {}
