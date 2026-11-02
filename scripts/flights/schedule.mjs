// Creates, or updates, the QStash schedule that stores what's in the air
// around Wellington every two minutes (src/pages/api/flights/sweep.ts), so
// trails are there for every visitor.
//
//   node --env-file=.env.local scripts/flights/schedule.mjs https://<site>
//
// Run it again with a different origin to move the schedule. QSTASH_URL and
// QSTASH_TOKEN come from the environment.

import { Client } from "@upstash/qstash";

const SCHEDULE_ID = "flights-sweep";

const origin = process.argv[2];
if (!origin?.startsWith("https://")) {
  console.error("usage: schedule.mjs https://<production origin>");
  process.exit(1);
}

const client = new Client();
const destination = new URL("/api/flights/sweep", origin).href;
await client.schedules.create({
  scheduleId: SCHEDULE_ID,
  destination,
  // 720 messages a day, inside QStash's free 1,000. Every minute would need
  // pay-as-you-go (about $0.45 a month).
  cron: "*/2 * * * *",
  method: "POST",
  // A missed sweep is caught by the next; no need to retry.
  retries: 0,
});

const schedule = await client.schedules.get(SCHEDULE_ID);
console.log(
  `${schedule.scheduleId}: ${schedule.cron} → ${schedule.destination}`
);
