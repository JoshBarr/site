import { neon } from "@neondatabase/serverless";
import { ColumnType, Kysely } from "kysely";
import { NeonDialect } from "kysely-neon";

// Postgres on Neon. Tables are created by scripts/db/migrate.mts.

type Timestamp = ColumnType<Date, Date | string, Date | string>;

/** Latest position heard from each ship. */
export interface VesselPositionsTable {
  mmsi: number;
  /** NZTM2000 metres. */
  easting: number;
  northing: number;
  /** m/s. */
  speed: number;
  /** Degrees from true north. */
  course: number | null;
  heading: number | null;
  reported_at: Timestamp;
}

/** What each ship has said about itself, kept as it's heard. */
export interface VesselStaticsTable {
  mmsi: number;
  name: string | null;
  /** AIS ship type. */
  type: number | null;
  /** Antenna to bow, stern, port and starboard, metres. */
  dimension: number[] | null;
}

/** A single row: who's listening to the AIS feed, and for how long today. */
export interface VesselListenerTable {
  id: ColumnType<boolean, boolean | undefined, never>;
  lease_until: Timestamp;
  day: ColumnType<Date, string, string>;
  /** Seconds of listening leased on `day`. */
  seconds: number;
}

export interface Database {
  vessel_positions: VesselPositionsTable;
  vessel_statics: VesselStaticsTable;
  vessel_listener: VesselListenerTable;
}

let db: Kysely<Database> | undefined;

/**
 * Queries go over HTTP, so there are no connections to hold open between
 * function invocations. No interactive transactions, though.
 */
export function getDb() {
  db ??= new Kysely<Database>({
    dialect: new NeonDialect({ neon: neon(process.env.DATABASE_URL) }),
  });
  return db;
}
