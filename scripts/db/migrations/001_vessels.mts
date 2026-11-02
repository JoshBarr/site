import { Kysely, sql } from "kysely";

// Live ships for the homepage scene: see src/lib/vesselStore.ts.

export async function up(db: Kysely<any>) {
  await db.schema
    .createTable("vessel_positions")
    .addColumn("mmsi", "integer", (c) => c.primaryKey())
    .addColumn("easting", "float8", (c) => c.notNull())
    .addColumn("northing", "float8", (c) => c.notNull())
    .addColumn("speed", "float4", (c) => c.notNull())
    .addColumn("course", "float4")
    .addColumn("heading", "float4")
    .addColumn("reported_at", "timestamptz", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("vessel_statics")
    .addColumn("mmsi", "integer", (c) => c.primaryKey())
    .addColumn("name", "text")
    .addColumn("type", "smallint")
    .addColumn("dimension", sql`smallint[]`)
    .execute();

  // One row at most.
  await db.schema
    .createTable("vessel_listener")
    .addColumn("id", "boolean", (c) =>
      c
        .primaryKey()
        .defaultTo(true)
        .check(sql`id`)
    )
    .addColumn("lease_until", "timestamptz", (c) => c.notNull())
    .addColumn("day", "date", (c) => c.notNull())
    .addColumn("seconds", "integer", (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable("vessel_listener").execute();
  await db.schema.dropTable("vessel_statics").execute();
  await db.schema.dropTable("vessel_positions").execute();
}
