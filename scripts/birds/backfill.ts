// Fills the birds collection (src/lib/birds.ts) with the checklists of the
// days before the Timetables Lambda started reading eBird's newest, so
// replays have the flocks as far back as they go: a day at a time, from
// eBird's feed of the checklists on a date. Each day's are an item at that
// day's NZ midnight (a replay keeps those begun by its time), expiring 35
// days after it, as the Lambda's would.
//
// Leaves out what's stored already, so it can be run again to fill in what
// it couldn't read; never writes over an item. eBird allows 500 requests an
// hour, so it asks every PACE: a month's ~650 is ~90 minutes. Runs as you,
// with your AWS credentials (`aws login`), not the site's read-only role:
//
//   npx jiti scripts/birds/backfill.ts [--days 30] [--pace 8] [--dry-run]

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  type BirdSightings,
  counted,
  fetchBirds,
  listChecklists,
  seenIn,
} from "../../src/lib/birds";
import { birds, toRecord } from "../../src/lib/liveRecords";
import { readSince } from "../../src/lib/liveTable";
import { nzDate, nzTime } from "../../src/lib/nzClock";

process.loadEnvFile(".env.local");

// That's the site's role, which can only read; this writes as you.
delete process.env.AWS_ROLE_ARN;

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "30" },
    // Seconds between requests: shorter for a few days' worth, which is
    // well under the hour's 500.
    pace: { type: "string", default: "8" },
    "dry-run": { type: "boolean", default: false },
  },
});

const DAY = 24 * 3600_000;

/** Between eBird requests: by default 450 an hour, of its 500. */
const PACE = Number(values.pace) * 1000;

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "ap-southeast-2",
});

/** Every birds item stored, and their times. */
async function stored() {
  const records = await readSince(birds, 0);

  return {
    found: records.map((record) => record.data),
    times: new Set(records.map((record) => record.sk)),
  };
}

let asked = 0;

async function pause() {
  if (asked++ > 0) await sleep(PACE);
}

async function main() {
  if (!process.env.LIVE_TABLE) throw new Error("no LIVE_TABLE");

  const days = Number(values.days);
  const today = nzDate(Date.now());
  const before = await stored();

  console.log(
    `${before.found.length} items stored, ${seenIn(before.found).ids.size} checklists read before`
  );

  // Oldest first, to yesterday: today's are the Lambda's.
  for (let back = days; back >= 1; back--) {
    const date = nzDate(nzTime(`${today} 12:00`) - back * DAY);
    const midnight = nzTime(`${date} 00:00`);

    // Read again each day: the Lambda stores the week's newest as it runs.
    const { found, times } = await stored();
    const seen = seenIn(found);

    await pause();

    const list = await listChecklists(date);
    let sightings: BirdSightings | null;

    try {
      sightings = await fetchBirds(list, seen, { pause });
    } catch (error) {
      console.warn(`${date}: none read: ${String(error)}`);
      continue;
    }

    if (!sightings) {
      console.log(`${date}: nothing new of ${list.length} listed`);
      continue;
    }

    // And again before writing, should the Lambda have run meanwhile.
    const since = seenIn((await stored()).found);

    sightings.checked = sightings.checked.filter((id) => !since.ids.has(id));
    sightings.checklists = sightings.checklists.filter(
      (c) => !since.ids.has(c.id) && !(c.group && since.groups.has(c.group))
    );

    if (sightings.checked.length === 0) {
      console.log(`${date}: stored meanwhile by the Lambda`);
      continue;
    }

    console.log(
      `${date}: ${sightings.checklists.length} checklists (${sightings.checked.length} read of ${list.length} listed), ${counted(sightings)} birds`
    );

    if (values["dry-run"]) continue;

    if (times.has(midnight)) {
      // Run before, and more found since: next to it, a second on.
      console.log(`${date}: an item's there; writing a second after it`);
    }

    let sk = midnight;

    while (times.has(sk)) sk += 1000;

    try {
      await client.send(
        new PutItemCommand({
          TableName: process.env.LIVE_TABLE,
          Item: z.encode(birds.schema, toRecord(birds, sk, sightings, sk)),
          ConditionExpression: "attribute_not_exists(pk)",
        })
      );
      times.add(sk);
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;

      console.warn(`${date}: an item's at ${sk} already; left`);
    }
  }
}

await main();
