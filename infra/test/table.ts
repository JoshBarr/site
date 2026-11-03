import type * as AWS from "@alchemy.run/aws";
import type { AttributeValue } from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import { z } from "zod";
import {
  type LiveData,
  type LiveRecord,
  toRecord,
} from "../../src/lib/liveRecords";
import { LiveTable } from "../poller/table";

// The live table in memory, behind the same operations Alchemy binds in
// Lambda: PutItem, and Query with the key conditions the poller asks.

type Item = Record<string, AttributeValue | undefined>;

interface Collection {
  pk: string;
  v: number;
  ttl: number;
  schema: z.ZodType<{ sk: unknown; data: unknown }, Item>;
}

const id = (item: Item) => `${item.pk?.S} ${item.sk?.S}`;

/** Whether `item` meets the query's key condition, as the poller words them. */
function matches(item: Item, query: AWS.DynamoDB.QueryRequest) {
  const values = query.ExpressionAttributeValues ?? {};

  if (item.pk?.S !== values[":pk"]?.S) return false;

  switch (query.KeyConditionExpression) {
    case "pk = :pk":
      return true;
    case "pk = :pk AND begins_with(sk, :prefix)":
      return item.sk?.S?.startsWith(values[":prefix"]?.S ?? "") ?? false;
    case "pk = :pk AND sk >= :from":
      return (item.sk?.S ?? "") >= (values[":from"]?.S ?? "");
    default:
      throw new Error(
        `fake table: condition ${query.KeyConditionExpression} isn't served`
      );
  }
}

/**
 * A new, empty table, and the LiveTable over it. Queries are paged every
 * `page` items, as DynamoDB pages them every 1 MB.
 */
export function makeTable({ page = Infinity } = {}) {
  const items = new Map<string, Item>();
  const queries: AWS.DynamoDB.QueryRequest[] = [];

  const service = LiveTable.of({
    putItem: ({ Item }) =>
      Effect.sync(() => {
        items.set(id(Item), Item);

        return {};
      }),

    query: (query) =>
      Effect.sync(() => {
        queries.push(query);

        const found = [...items.values()]
          .filter((item) => matches(item, query))
          .sort((a, b) => (a.sk?.S ?? "").localeCompare(b.sk?.S ?? ""));

        if (query.ScanIndexForward === false) found.reverse();

        const after = query.ExclusiveStartKey;

        const from = after
          ? found.findIndex((i) => id(i) === id(after)) + 1
          : 0;

        const Items = found.slice(
          from,
          from + Math.min(query.Limit ?? Infinity, page)
        );

        const last = Items.at(-1);

        const more = last && from + Items.length < found.length;

        return {
          Items,
          ...(more && { LastEvaluatedKey: { pk: last.pk, sk: last.sk } }),
        };
      }),
  });

  return {
    service,
    queries,

    /** Stores `data` as `c`'s item at `sk`, written at `written`. */
    seed<C extends Collection>(
      c: C,
      sk: LiveRecord<C>["sk"],
      data: LiveData<C>,
      written: number
    ) {
      const item = z.encode(c.schema, toRecord(c, sk, data, written));
      items.set(id(item), item);
    },

    /** Stores `item` as it is. */
    seedItem(item: Item) {
      items.set(id(item), item);
    },

    /** Every one of `c`'s items, in sort key order, as it reads them. */
    records<C extends Collection>(c: C) {
      const stored = [...items.values()]
        .filter((item) => item.pk?.S === c.pk)
        .sort((a, b) => (a.sk?.S ?? "").localeCompare(b.sk?.S ?? ""));

      // SAFETY: c.schema reads LiveRecord<C>; Collection only widens it.
      return stored.map((item) => z.decode(c.schema, item) as LiveRecord<C>);
    },

    /** Every item, as stored. */
    items: () => [...items.values()],
  };
}
