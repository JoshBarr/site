// Brings the Neon database up to date with scripts/db/migrations.
//
//   npm run db:migrate              (reads .env.local)
//
// Uses the direct (unpooled) connection over a WebSocket, so each migration
// runs in a transaction; the app's HTTP driver can't do those.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";

const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("missing DATABASE_URL_UNPOOLED");

const db = new Kysely<any>({
  dialect: new PostgresDialect({
    // Neon's Pool is pg's, but its Client.connect() is typed as void.
    pool: new Pool({ connectionString }) as unknown as PostgresPool,
  }),
});

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({
    fs,
    path,
    migrationFolder: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "migrations"
    ),
  }),
});

const { error, results } = await migrator.migrateToLatest();
for (const { migrationName, status } of results ?? []) {
  console.log(`${status === "Success" ? "✓" : "✗"} ${migrationName} ${status}`);
}
if (!results?.length) console.log("Already up to date.");
await db.destroy();

if (error) {
  console.error(error);
  process.exitCode = 1;
}
