import * as AWS from "@alchemy.run/aws";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Live } from "../live";
import { LiveTable } from "../poller/table";
import { updateCableCar } from "./cablecar";

// Keeps the timetables the scene runs to (just the cable car's, so far) in
// the live table, checking Metlink's GTFS feed for a new one each morning:
// new ones are published in the small hours of the day they start (the last
// at 4:05 am), and until it's read the scene runs the cars to the old one's
// same day of the week. Its own function, not one of the poller's feeds:
// reading the feed's stop times takes ~15 MB, and the poller runs within a
// few MB of its 160.

export default class Timetables extends AWS.Lambda.Function<Timetables>()(
  "Timetables",
  {
    main: import.meta.url,
    functionUrl: false,
    architecture: "arm64",
    // As the poller, with room for the stop times. A second or so a day, a
    // few when there's a new timetable: ~15 GB-s a month, and if every run
    // took its full minute, ~300, of the free 400k (the poller takes ~357k).
    memorySize: 160,
    timeout: Duration.seconds(60),
    // A failed morning is tried again the next.
    eventInvokeConfig: { maximumRetryAttempts: 0, maximumEventAge: "1 hour" },
    logging: { retention: "1 day" },
  },
  Effect.gen(function* () {
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
      () =>
        updateCableCar.pipe(
          Effect.catchCause((cause) => Effect.logError("[cablecar]", cause)),
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
