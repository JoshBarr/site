import type * as AWS from "@alchemy.run/aws";
import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { z } from "zod";
import {
  type LiveData,
  type LiveRecord,
  sortTime,
  toRecord,
} from "../../src/lib/liveRecords";

// The live table (see ../live.ts and plans/dynamo.md): each feed's polls
// appended to its log, and the routes and headings collections. Items are
// written and read through the schemas in src/lib/liveRecords.ts, which the
// site reads them with too.

/**
 * The table's operations: in Lambda, Alchemy's bindings to it, which also
 * grant the function each one.
 */
export class LiveTable extends Context.Service<
  LiveTable,
  {
    readonly putItem: (
      request: AWS.DynamoDB.PutItemRequest
    ) => Effect.Effect<DynamoDB.PutItemOutput, DynamoDB.PutItemError>;
    readonly query: (
      request: AWS.DynamoDB.QueryRequest
    ) => Effect.Effect<DynamoDB.QueryOutput, DynamoDB.QueryError>;
  }
>()("LiveTable") {}

type Item = Record<string, DynamoDB.AttributeValue | undefined>;

/** A collection, as src/lib/liveRecords.ts defines them. */
interface Collection {
  pk: string;
  v: number;
  ttl: number;
  schema: z.ZodType<{ sk: unknown; data: unknown }, Item>;
}

/**
 * Stores `data` as `c`'s item at `sk`, written at `written` (epoch ms).
 * Its gzipped size, bytes.
 */
export const put = <C extends Collection>(
  c: C,
  sk: LiveRecord<C>["sk"],
  data: LiveData<C>,
  written: number
) =>
  Effect.gen(function* () {
    const live = yield* LiveTable;
    const Item = z.encode(c.schema, toRecord(c, sk, data, written));

    yield* live.putItem({ Item });

    return Item.data?.B?.length ?? 0;
  });

/** `items` that are `c`'s, as it reads them; the rest are logged and left. */
const decode = <C extends Collection>(c: C, items: Item[] = []) =>
  Effect.gen(function* () {
    const records: LiveRecord<C>[] = [];

    for (const item of items) {
      const result = z.safeDecode(c.schema, item);

      if (result.success) {
        // SAFETY: c.schema reads LiveRecord<C>; Collection only widens it.
        records.push(result.data as LiveRecord<C>);
      } else {
        // Written by another version of the poller, say.
        yield* Effect.logWarning(
          `[${c.pk}] skipped ${item.sk?.S}:`,
          z.prettifyError(result.error)
        );
      }
    }

    return records;
  });

/**
 * `c`'s newest item, of those whose sort key starts with `prefix`; null if
 * there's none, or it isn't one `c` reads.
 */
export const newest = <C extends Collection>(c: C, prefix?: string) =>
  Effect.gen(function* () {
    const live = yield* LiveTable;

    const { Items } = yield* live.query({
      KeyConditionExpression:
        prefix === undefined
          ? "pk = :pk"
          : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": { S: c.pk },
        ...(prefix !== undefined && { ":prefix": { S: prefix } }),
      },
      ScanIndexForward: false,
      Limit: 1,
    });

    const [record] = yield* decode(c, Items);

    return record ?? null;
  });

/**
 * Every one of `c`'s items it reads, oldest first, a page at a time: with
 * `from` (epoch ms), those whose sort key is a time no earlier.
 */
export const all = <C extends Collection>(c: C, from?: number) =>
  Effect.gen(function* () {
    const live = yield* LiveTable;
    const records: LiveRecord<C>[] = [];
    let start: Item | undefined;

    do {
      const { Items, LastEvaluatedKey } = yield* live.query({
        KeyConditionExpression:
          from === undefined ? "pk = :pk" : "pk = :pk AND sk >= :from",
        ExpressionAttributeValues: {
          ":pk": { S: c.pk },
          ...(from !== undefined && { ":from": { S: sortTime(from) } }),
        },
        ExclusiveStartKey: start,
      });

      records.push(...(yield* decode(c, Items)));
      start = LastEvaluatedKey;
    } while (start);

    return records;
  });
