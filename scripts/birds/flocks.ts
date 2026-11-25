// Sums up where the flocks gathered (src/lib/flocks.ts) for the times before
// the Timetables Lambda started to, from the checklists stored then, so
// replays have flocks as far back as there are checklists: every three
// hours at :40, as the Lambda does, each from the birds items up to it.
// Reads the table, not eBird. A time the Lambda (or an earlier run) has
// summed up already is left, unless --rebuild: then this script's own are
// written again, say once the backfill's added more days.
//
// Runs as you, with your AWS credentials (`aws login`), not the site's
// read-only role:
//
//   npx jiti scripts/birds/flocks.ts [--rebuild] [--dry-run]

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { summarise } from "../../src/lib/flocks";
import { birds, flocks, toRecord } from "../../src/lib/liveRecords";
import { readSince } from "../../src/lib/liveTable";
import { nzDate, nzTime } from "../../src/lib/nzClock";
import { REPLAY } from "../../src/lib/replay";

process.loadEnvFile(".env.local");

// That's the site's role, which can only read; this writes as you.
delete process.env.AWS_ROLE_ARN;

const { values } = parseArgs({
  options: {
    rebuild: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const HOUR = 3_600_000;
const EVERY = 3 * HOUR;
const DAY = 24 * HOUR;

/** Between writes: each ~7 KB is ~7 WCU, of the table's 25 a second. */
const PAUSE = 400;

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "ap-southeast-2",
});

/** The Lambda's times, :40 every three hours NZ, from `from` to `to`. */
function slots(from: number, to: number) {
  const times: number[] = [];

  for (let day = nzDate(from); ;) {
    for (let hour = 0; hour < 24; hour += 3) {
      const time = nzTime(`${day} ${String(hour).padStart(2, "0")}:40`);

      if (time > to) return times;

      if (time >= from) times.push(time);
    }

    day = nzDate(nzTime(`${day} 12:00`) + DAY);
  }
}

async function main() {
  if (!process.env.LIVE_TABLE) throw new Error("no LIVE_TABLE");

  const now = Date.now();
  const stored = await readSince(birds, now - REPLAY - 30 * DAY);
  const summed = await readSince(flocks, now - REPLAY);

  if (stored.length === 0) throw new Error("no birds stored");

  // From when the first checklists were stored, or replays go back to.
  const times = slots(Math.max(stored[0].sk, now - REPLAY), now);
  let written = 0;

  for (const time of times) {
    const mine = summed.some((s) => s.sk === time);

    // Summed up by the Lambda, or by a run before, in this slot.
    const taken = summed.some(
      (s) => s.sk >= time && s.sk < time + EVERY && s.sk !== time
    );

    if (taken || (mine && !values.rebuild)) continue;

    const summary = summarise(
      stored.filter((r) => r.sk <= time).map((r) => r.data),
      time
    );

    if (summary.sites.length === 0) continue;

    if (values["dry-run"]) {
      console.log(
        `${new Date(time).toISOString()}: ${summary.sites.length} sites`
      );
      continue;
    }

    await client.send(
      new PutItemCommand({
        TableName: process.env.LIVE_TABLE,
        Item: z.encode(flocks.schema, toRecord(flocks, time, summary, time)),
      })
    );

    written++;
    await sleep(PAUSE);
  }

  console.log(`${written} summaries written, of ${times.length} times`);
}

await main();
