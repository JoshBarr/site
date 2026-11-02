import { Kysely } from "kysely";

// Flight fixes moved to Upstash Redis (src/lib/flightStore.ts): sweeping
// every couple of minutes would keep Neon's compute from ever scaling down.

export async function up(db: Kysely<any>) {
  await db.schema.dropTable("flight_fixes").ifExists().execute();
}

export async function down() {
  // 002_flights describes the table, if it's ever wanted back.
}
