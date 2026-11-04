// Fills the time-travel timeline (src/lib/timeline.ts) for the hours before
// the poller started counting, from its logs: one sample per five-minute
// slot (the poller takes one a minute), each from every log's newest poll
// at the slot's middle. Only hours that are over, and of those, only those
// without an item yet, so it never writes over the poller's.
//
// Reads ~4 RCU a slot and goes a slot a second, so the site's reads (25 RCU
// a second, shared) keep plenty of room. Runs as you, with your AWS
// credentials (`aws login`), not the site's read-only role:
//
//   npx jiti scripts/timeline/backfill.ts [--from <ISO time>] [--dry-run]
//     [--out <file.json>]

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  buses,
  flights,
  quakes,
  tide,
  timeline,
  toRecord,
  traffic,
  trains,
  vessels,
  weather,
} from "../../src/lib/liveRecords";
import { readNewest, readSince } from "../../src/lib/liveTable";
import {
  addSample,
  hourOf,
  sample,
  SLOT,
  type TimelineHour,
} from "../../src/lib/timeline";

process.loadEnvFile(".env.local");

// That's the site's role, which can only read; this writes as you.
delete process.env.AWS_ROLE_ARN;

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    // Writes the hours to this JSON file instead of the table.
    out: { type: "string" },
  },
});

/** Between slots, ms. */
const PACE = 1000;

/** The newest of `polls` (oldest first) at or before `time`. */
const asOf = <P extends { sk: number }>(polls: P[], time: number) =>
  polls.findLast(({ sk }) => sk <= time);

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "ap-southeast-2",
});

/** When the buses log's oldest poll was, epoch ms: one item read. */
async function oldestPoll() {
  const { Items = [] } = await client.send(
    new QueryCommand({
      TableName: process.env.LIVE_TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: buses.pk } },
      ProjectionExpression: "sk",
      Limit: 1,
    })
  );

  const sk = Items[0]?.sk?.S;

  return sk === undefined ? null : Number(sk);
}

async function main() {
  const now = Date.now();
  const first = values.from ? Date.parse(values.from) : await oldestPoll();

  if (first === null || Number.isNaN(first)) {
    throw new Error("nothing logged to count from: give --from");
  }

  const from = Math.ceil(first / SLOT) * SLOT;
  // Whole hours only, so running it again later fills the hours since
  // rather than finding this one's half done and leaving it.
  const to = hourOf(now);

  const counted = new Set(
    (await readSince(timeline, hourOf(from))).map(({ sk }) => sk)
  );

  // Small and seldom written: read whole.
  const [weathers, tides, quakeLists] = await Promise.all([
    readSince(weather, from - 3_600_000, to),
    readSince(tide, from - 3_600_000, to),
    readSince(quakes, from - 3_600_000, to),
  ]);

  console.log(
    `${new Date(from).toISOString()} → ${new Date(to).toISOString()}: ` +
      `${(to - from) / SLOT} slots, ${counted.size} hours counted already`
  );

  const hours = new Map<number, TimelineHour>();

  for (let slot = from; slot < to; slot += SLOT) {
    if (counted.has(hourOf(slot))) continue;

    const at = slot + SLOT / 2;

    const [t, b, f, v, s] = await Promise.all([
      readNewest(trains, "", at),
      readNewest(buses, "", at),
      readNewest(flights, "", at),
      readNewest(vessels, "", at),
      readNewest(traffic, "", at),
    ]);

    const latest = {
      trains: t ?? undefined,
      buses: b ?? undefined,
      flights: f ?? undefined,
      vessels: v ?? undefined,
      traffic: s ?? undefined,
      weather: asOf(weathers, at),
      tide: asOf(tides, at),
    };

    const hour = hourOf(at);
    const taken = sample(latest, at);

    hours.set(
      hour,
      addSample(
        hours.get(hour) ?? null,
        at,
        taken,
        asOf(quakeLists, at)?.data.quakes
      )
    );

    process.stdout.write(
      `\r${new Date(at).toISOString()}  ` +
        (["trains", "buses", "flights", "ships", "roads"] as const)
          .map((metric) => `${metric} ${taken[metric]?.toFixed(0) ?? "–"}`)
          .join("  ") +
        "   "
    );

    await sleep(PACE);
  }

  process.stdout.write("\n");

  if (values.out) {
    const hoursJson = [...hours].map(([sk, data]) => ({ sk, data }));

    writeFileSync(values.out, JSON.stringify(hoursJson));
    console.log(`wrote ${hours.size} hours to ${values.out}`);

    return;
  }

  for (const [sk, data] of hours) {
    const Item = z.encode(
      timeline.schema,
      toRecord(timeline, sk, data, Date.now())
    );

    if (values["dry-run"]) {
      console.log(`would write ${new Date(sk).toISOString()}`);
      continue;
    }

    try {
      await client.send(
        new PutItemCommand({
          TableName: process.env.LIVE_TABLE,
          Item,
          // Not over one the poller's started since.
          ConditionExpression: "attribute_not_exists(sk)",
        })
      );

      console.log(`wrote ${new Date(sk).toISOString()}`);
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;

      console.log(`skipped ${new Date(sk).toISOString()}: counted since`);
    }
  }
}

await main();
