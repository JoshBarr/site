import * as AWS from "@alchemy.run/aws";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Live, Positions } from "../live";
import { makeFeeds } from "./feeds";
import { pollMinute } from "./minute";
import { LiveBucket, publisher } from "./positions";
import { LiveTable } from "./table";
import { counter } from "./timeline";

// Polls the live feeds into DynamoDB every minute, counts what's out for
// the timeline, and publishes what the site serves to S3 (see plans/infra.md and plans/dynamo.md). The
// constructor runs once per container, and at deploy, when the bindings and
// schedule below become IAM grants, env vars and an EventBridge schedule.

export default class Poller extends AWS.Lambda.Function<Poller>()(
  "Poller",
  {
    main: import.meta.url,
    functionUrl: false,
    architecture: "arm64",
    // 128 MB ran at 127 used. 160 MB for ~52 s a minute is ~357k GB-s a
    // month, of Lambda's free 400k; 176 MB or more would go past it.
    memorySize: 160,
    // Polls stop 52 s in; a minute's interrupted at 58 s, and Lambda gives
    // up 2 s later.
    timeout: Duration.seconds(58),
    timeoutMargin: Duration.seconds(2),
    // A failed minute is followed by the next one.
    eventInvokeConfig: { maximumRetryAttempts: 0, maximumEventAge: "1 minute" },
    logging: { retention: "1 day" },
  },
  Effect.gen(function* () {
    // From the env file at deploy, into the function's environment. Open
    // Waters answers without a token, on a shared limit.
    const metlinkKey = yield* Config.Redacted("METLINK_API_KEY");
    const metserviceKey = yield* Config.Redacted("METSERVICE_API_KEY");

    const openWatersToken = yield* Config.Redacted("OPENWATERS_TOKEN").pipe(
      Config.option
    );

    const table = yield* Live;

    const live = LiveTable.of({
      putItem: yield* AWS.DynamoDB.PutItem(table),
      query: yield* AWS.DynamoDB.Query(table),
    });

    const bucket = LiveBucket.of({
      putObject: yield* AWS.S3.PutObject(yield* Positions),
    });

    const made = yield* makeFeeds;

    const feeds = [
      ...Object.values(made.logs),
      yield* counter(made),
      yield* publisher(made),
    ];

    // src/lib looks for its keys in process.env.
    const useKeys = Effect.sync(() => {
      process.env.METLINK_API_KEY = Redacted.value(metlinkKey);
      process.env.METSERVICE_API_KEY = Redacted.value(metserviceKey);

      if (Option.isSome(openWatersToken)) {
        process.env.OPENWATERS_TOKEN = Redacted.value(openWatersToken.value);
      }
    });

    // The service itself, not `consumeSchedule`, so the schedule can be
    // told not to retry: a late minute is no use.
    const schedule = yield* AWS.Scheduler.ScheduleEventSource;

    yield* schedule(
      {
        id: "EveryMinute",
        expression: "rate(1 minute)",
        props: {
          retryPolicy: {
            MaximumRetryAttempts: 0,
            MaximumEventAgeInSeconds: 60,
          },
        },
      },
      () =>
        useKeys.pipe(
          Effect.andThen(pollMinute(feeds)),
          Effect.provideService(LiveTable, live),
          Effect.provideService(LiveBucket, bucket)
        )
    );

    return {};
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.DynamoDB.PutItemHttp,
        AWS.DynamoDB.QueryHttp,
        AWS.S3.PutObjectHttp,
        AWS.Lambda.ScheduleEventSource
      )
    )
  )
) {}
