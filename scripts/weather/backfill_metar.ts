// Fills the METAR log (src/lib/metar.ts) for the time before the poller
// started asking, from Iowa State's archive of Wellington Airport's reports
// (NOAA's own API only keeps about two weeks), so replays have what was
// observed as far back as they go: each report once, at about when the
// poller would have logged it (they reach NOAA a few minutes after they're
// observed). Each expires 30 days after its time, as the poller's would have.
//
// Writes only before the poller's oldest METAR, and never over an item, at
// about WRITES a second: each item's well under 1 KB, so 1 WCU, against the
// table's 25. Runs as you, with your AWS credentials (`aws login`), not the
// site's read-only role:
//
//   npx jiti scripts/weather/backfill_metar.ts [--from <ISO time>] [--dry-run]

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { metar, toRecord } from "../../src/lib/liveRecords";
import { parseMetar } from "../../src/lib/metar";

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

/** About how long after it's observed a report reaches NOAA, ms. */
const SENT = 4 * MINUTE;

/** Writes a second, at most. */
const WRITES = 10;

const ARCHIVE = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "ap-southeast-2",
});

/** When the METAR log's oldest poll was, epoch ms: one item read. */
async function oldestPoll() {
  const { Items = [] } = await client.send(
    new QueryCommand({
      TableName: process.env.LIVE_TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: metar.pk } },
      ProjectionExpression: "sk",
      Limit: 1,
    })
  );

  const sk = Items[0]?.sk?.N ?? Items[0]?.sk?.S;

  return sk === undefined ? null : Number(sk);
}

/** Every routine and special report from `from` to `to`, oldest first. */
async function reports(from: number, to: number) {
  const start = new Date(from);
  const end = new Date(to + DAY);

  const params = new URLSearchParams({
    station: "NZWN",
    data: "metar",
    year1: String(start.getUTCFullYear()),
    month1: String(start.getUTCMonth() + 1),
    day1: String(start.getUTCDate()),
    year2: String(end.getUTCFullYear()),
    month2: String(end.getUTCMonth() + 1),
    day2: String(end.getUTCDate()),
    tz: "Etc/UTC",
    format: "onlycomma",
    latlon: "no",
    missing: "M",
    trace: "T",
    direct: "no",
  });

  params.append("report_type", "3");
  params.append("report_type", "4");

  const response = await fetch(`${ARCHIVE}?${params}`);

  if (!response.ok) throw new Error(`archive: HTTP ${response.status}`);

  const seen = new Set<number>();

  // station,valid,metar: valid is UTC, "YYYY-MM-DD HH:MM".
  return (await response.text())
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const [, valid, raw] = line.split(",");
      const time = Date.parse(`${valid?.replace(" ", "T")}:00Z`);

      if (!raw || !Number.isFinite(time) || seen.has(time)) return [];

      if (time < from || time >= to) return [];

      seen.add(time);

      return [parseMetar(raw, time)];
    })
    .sort((a, b) => a.time - b.time);
}

async function main() {
  const now = Date.now();
  // Replays go back 30 days, and items are kept 30 days from their time.
  const earliest = now - 30 * DAY + 10 * MINUTE;
  const from = values.from ? Date.parse(values.from) : earliest;

  if (Number.isNaN(from)) throw new Error("--from isn't a time");

  const live = await oldestPoll();
  // The poller logs each report a few minutes after it's observed.
  const to = live === null ? now : live - SENT;
  const found = await reports(from, to);

  console.log(
    `${new Date(from).toISOString()} → ${new Date(to).toISOString()}` +
      `${live ? " (the poller's first)" : ""}: ${found.length} reports`
  );

  let written = 0;
  let skipped = 0;

  for (const observed of found) {
    const started = Date.now();
    const polled = observed.time + SENT;

    if (values["dry-run"]) {
      if (written < 3 || written === found.length - 1) {
        console.log(JSON.stringify(observed));
      }

      written++;
      continue;
    }

    const Item = z.encode(
      metar.schema,
      // Kept as long from its time as the poller's.
      toRecord(metar, polled, observed, polled)
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
      `\r${new Date(polled).toISOString()}  ${written} written, ${skipped} there already  `
    );

    await sleep(Math.max(0, 1000 / WRITES - (Date.now() - started)));
  }

  process.stdout.write("\n");
  console.log(
    `${values["dry-run"] ? "would write" : "wrote"} ${written}, ` +
      `${skipped} there already`
  );
}

await main();
