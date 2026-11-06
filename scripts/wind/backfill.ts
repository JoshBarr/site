// Fills the wind log (src/lib/windStations.ts) for the time before the
// poller started asking, from GWRC's Hilltop history, so replays have the
// stations' wind as far back as they go: one poll every five minutes, each
// what the poller would have logged then (the air quality stations upload
// once an hour, so their readings here are a little fresher than it'd have
// had). Each expires 30 days after its time, as the poller's would have.
//
// Writes only before the poller's oldest wind poll, and never over an item,
// at about WRITES a second: each item's well under 1 KB, so 1 WCU, against
// the table's 25. Runs as you, with your AWS credentials (`aws login`), not
// the site's read-only role:
//
//   npx jiti scripts/wind/backfill.ts [--from <ISO time>] [--dry-run]

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { hilltop, readings } from "../../src/lib/hilltop";
import { toRecord, windStations } from "../../src/lib/liveRecords";
import { pair, STATIONS, windAt } from "../../src/lib/windStations";

process.loadEnvFile(".env.local");

// That's the site's role, which can only read; this writes as you.
delete process.env.AWS_ROLE_ARN;

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Between polls, as the poller logs them. */
const EVERY = 5 * MINUTE;

/** Writes a second, at most. */
const WRITES = 10;

/** Hilltop's history is asked for this much at a time. */
const CHUNK = 7 * DAY;

/** Fetched back this far before the first poll, for its freshest readings. */
const LEAD = 2 * 60 * MINUTE;

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "ap-southeast-2",
});

/** Hilltop's time for epoch ms: NZST, without saying so. */
const nzst = (time: number) =>
  new Date(time + 12 * 60 * MINUTE).toISOString().slice(0, 19);

/** When the wind log's oldest poll was, epoch ms: one item read. */
async function oldestPoll() {
  const { Items = [] } = await client.send(
    new QueryCommand({
      TableName: process.env.LIVE_TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: windStations.pk } },
      ProjectionExpression: "sk",
      Limit: 1,
    })
  );

  const sk = Items[0]?.sk?.N ?? Items[0]?.sk?.S;

  return sk === undefined ? null : Number(sk);
}

/** A station's measurement from `from` to `to`, a chunk at a time. */
async function history(
  site: string,
  measurement: string,
  from: number,
  to: number
) {
  const all: { at: number; value: number }[] = [];

  for (let start = from; start < to; start += CHUNK) {
    const body = await hilltop({
      Request: "GetData",
      Site: site,
      Measurement: measurement,
      From: nzst(start),
      To: nzst(Math.min(start + CHUNK, to)),
    }).catch((e) => {
      // A stretch with nothing in it.
      if (e instanceof Error && e.message.includes("No data")) return "";

      throw e;
    });

    all.push(...readings(body));
  }

  return all;
}

async function main() {
  const now = Date.now();
  // Replays go back 30 days, and items are kept 30 days from their time.
  const earliest = Math.ceil((now - 30 * DAY + 10 * MINUTE) / EVERY) * EVERY;

  const from = values.from
    ? Math.ceil(Date.parse(values.from) / EVERY) * EVERY
    : earliest;

  if (Number.isNaN(from)) throw new Error("--from isn't a time");

  const live = await oldestPoll();
  const to = live ?? now;

  console.log(
    `${new Date(from).toISOString()} → ${new Date(to).toISOString()}` +
      `${live ? " (the poller's first)" : ""}: ${Math.ceil((to - from) / EVERY)} polls`
  );

  const stations = await Promise.all(
    STATIONS.map(async ({ site, speed, direction, scale }) => {
      const [speeds, directions] = await Promise.all([
        history(site, speed, from - LEAD, to),
        history(site, direction, from - LEAD, to),
      ]);

      const paired = pair(speeds, directions, scale);
      console.log(`  ${site}: ${paired.length} readings`);

      return { site, paired };
    })
  );

  let written = 0;
  let skipped = 0;
  let empty = 0;

  for (let time = from; time < to; time += EVERY) {
    const started = Date.now();

    const data = {
      time,
      stations: stations.flatMap(({ site, paired }) => {
        const reading = windAt(site, paired, time);

        return reading ? [reading] : [];
      }),
    };

    // The scene makes nothing of a poll with none.
    if (!data.stations.length) {
      empty++;
      continue;
    }

    if (values["dry-run"]) {
      if (written < 3 || time + EVERY >= to) {
        console.log(JSON.stringify(data));
      }

      written++;
      continue;
    }

    const Item = z.encode(
      windStations.schema,
      // Kept as long from its time as the poller's.
      toRecord(windStations, time, data, time)
    );

    try {
      await client.send(
        new PutItemCommand({
          TableName: process.env.LIVE_TABLE,
          Item,
          ConditionExpression: "attribute_not_exists(sk)",
        })
      );

      written++;
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
      skipped++;
    }

    process.stdout.write(
      `\r${new Date(time).toISOString()}  ${written} written, ${skipped} there already  `
    );

    await sleep(Math.max(0, 1000 / WRITES - (Date.now() - started)));
  }

  process.stdout.write("\n");
  console.log(
    `${values["dry-run"] ? "would write" : "wrote"} ${written}, ` +
      `${skipped} there already, ${empty} with no station heard from`
  );
}

await main();
