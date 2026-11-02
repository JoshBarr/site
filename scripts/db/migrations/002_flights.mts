import { Kysely } from "kysely";

// Aircraft positions for the homepage scene's trails: see src/lib/flightStore.ts.

export async function up(db: Kysely<any>) {
  await db.schema
    .createTable("flight_fixes")
    .addColumn("hex", "text", (c) => c.notNull())
    .addColumn("time", "timestamptz", (c) => c.notNull())
    .addColumn("easting", "float8", (c) => c.notNull())
    .addColumn("northing", "float8", (c) => c.notNull())
    .addColumn("altitude", "float4")
    .addColumn("speed", "float4", (c) => c.notNull())
    .addColumn("track", "float4")
    .addColumn("climb", "float4")
    .addColumn("callsign", "text")
    .addColumn("registration", "text")
    .addColumn("aircraft_type", "text")
    .addColumn("category", "text")
    .addPrimaryKeyConstraint("flight_fixes_pkey", ["hex", "time"])
    .execute();

  await db.schema
    .createIndex("flight_fixes_time")
    .on("flight_fixes")
    .column("time")
    .execute();
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable("flight_fixes").execute();
}
