// The scene's frame times over the last week (or --days), as the site has
// counted them (src/pages/api/frames.ts): visits by tier and backend, and
// for each kind of visit how its median and 95th-percentile frame times
// fell. Runs as you, with your AWS credentials (`aws login`):
//
//   npx jiti scripts/telemetry/week.ts [--days 7]

import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { parseArgs } from "node:util";
import { dayOf, FRAMES_PK } from "../../src/lib/frames";

process.loadEnvFile(".env.local");

// That's the site's role; this reads as you.
delete process.env.AWS_ROLE_ARN;

const { values } = parseArgs({
  options: { days: { type: "string", default: "7" } },
});

const DAY = 86_400_000;
const days = Number(values.days);
const to = dayOf(Date.now());
const from = dayOf(Date.now() - (days - 1) * DAY);

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "ap-southeast-2",
});

const { Items = [] } = await client.send(
  new QueryCommand({
    TableName: process.env.LIVE_TABLE,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
    ExpressionAttributeValues: {
      ":pk": { S: FRAMES_PK },
      ":from": { S: from },
      ":to": { S: to },
    },
  })
);

const totals = new Map<string, number>();

for (const item of Items) {
  for (const [name, value] of Object.entries(item)) {
    if (name === "pk" || name === "sk" || name === "expires" || !value.N) {
      continue;
    }

    totals.set(name, (totals.get(name) ?? 0) + Number(value.N));
  }
}

const visits = totals.get("visits") ?? 0;

console.log(`${from} to ${to}: ${visits} visits over ${Items.length} days\n`);

/** Each counter under `prefix`, as a share of `of`. */
function table(prefix: string, of: number) {
  const rows = [...totals]
    .flatMap(([name, count]) =>
      name.startsWith(prefix)
        ? [[name.slice(prefix.length), count] as const]
        : []
    )
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }));

  for (const [name, count] of rows) {
    const share = of ? ((count / of) * 100).toFixed(1) : "-";

    console.log(`  ${name.padEnd(10)} ${String(count).padStart(6)}  ${share}%`);
  }
}

for (const group of ["tier", "backend", "kind"]) {
  console.log(group);
  table(`${group}:`, visits);
}

const kinds = [...totals.keys()].flatMap((name) =>
  name.startsWith("kind:") ? [name.slice("kind:".length)] : []
);

for (const kind of kinds) {
  const count = totals.get(`kind:${kind}`) ?? 0;

  for (const measure of ["median", "p95"]) {
    console.log(`\n${kind} ${measure} frame time, ms up to`);
    table(`${measure}:${kind}:`, count);
  }

  // Under 1, the governor had made the scene smaller to keep up.
  console.log(`\n${kind} scale the scene was drawn at`);
  table(`scale:${kind}:`, count);
}

for (const measure of ["megapixels", "dpr"]) {
  console.log(`\n${measure}`);
  table(`${measure}:`, visits);
}
