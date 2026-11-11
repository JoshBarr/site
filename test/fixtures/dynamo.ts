import { http, HttpResponse } from "msw/http";
import { z } from "zod";
import {
  type LiveData,
  type LiveRecord,
  toRecord,
} from "../../src/lib/liveRecords";
import { server } from "../msw";

// The live table, as DynamoDB's JSON API answers the queries the site makes
// (src/lib/liveTable.ts), with items written by the schemas the poller
// writes with.

const ENDPOINT = "https://dynamodb.ap-southeast-2.amazonaws.com/";

/** An attribute as it goes over the wire: binary is base64. */
const wireValue = z.object({
  S: z.string().optional(),
  N: z.string().optional(),
  B: z.string().optional(),
});

type Wire = Record<string, z.infer<typeof wireValue>>;

const query = z.object({
  TableName: z.string(),
  KeyConditionExpression: z.string(),
  ExpressionAttributeValues: z.record(z.string(), wireValue),
  ScanIndexForward: z.boolean().optional(),
  Limit: z.number().optional(),
});

interface Collection {
  pk: string;
  v: number;
  ttl: number;
  schema: z.ZodType<{ sk: unknown; data: unknown }>;
}

const update = z.object({
  TableName: z.string(),
  Key: z.object({ pk: wireValue, sk: wireValue }),
  UpdateExpression: z.string(),
  ExpressionAttributeNames: z.record(z.string(), z.string()),
  ExpressionAttributeValues: z.record(z.string(), wireValue),
});

/**
 * `asked` done to `items`, for the one update the site makes (addOne in
 * src/lib/liveTable.ts): ADD numbers, and SET one if it's not there.
 */
function added(items: Wire[], asked: z.infer<typeof update>) {
  const { Key, UpdateExpression, ExpressionAttributeNames: names } = asked;
  const values = asked.ExpressionAttributeValues;

  const shape = /^ADD (.+) SET (\w+) = if_not_exists\(\2, (:\w+)\)$/.exec(
    UpdateExpression
  );

  if (!shape) throw new Error(`fake table: ${UpdateExpression} isn't served`);

  let item = items.find((i) => i.pk?.S === Key.pk.S && i.sk?.S === Key.sk.S);

  if (!item) {
    item = { pk: Key.pk, sk: Key.sk };
    items.push(item);
  }

  for (const term of shape[1].split(", ")) {
    const [name, value] = term.split(" ");
    const attribute = names[name] ?? name;
    const before = Number(item[attribute]?.N ?? 0);

    item[attribute] = { N: String(before + Number(values[value]?.N)) };
  }

  item[shape[2]] ??= values[shape[3]];
}

/** Whether `item` meets the key condition, as the site words them. */
function matches(
  item: Wire,
  {
    KeyConditionExpression,
    ExpressionAttributeValues: values,
  }: z.infer<typeof query>
) {
  const sk = item.sk?.S ?? "";

  if (item.pk?.S !== values[":pk"]?.S) return false;

  switch (KeyConditionExpression) {
    case "pk = :pk":
      return true;
    case "pk = :pk AND sk >= :from":
      return sk >= (values[":from"]?.S ?? "");
    case "pk = :pk AND begins_with(sk, :prefix)":
      return sk.startsWith(values[":prefix"]?.S ?? "");
    case "pk = :pk AND sk BETWEEN :from AND :to":
      return sk >= (values[":from"]?.S ?? "") && sk <= (values[":to"]?.S ?? "");
    case "pk = :pk AND sk BETWEEN :prefix AND :to":
      return (
        sk >= (values[":prefix"]?.S ?? "") && sk <= (values[":to"]?.S ?? "")
      );
    case "pk = :pk AND sk <= :to":
      return sk <= (values[":to"]?.S ?? "");
    default:
      throw new Error(`fake table: ${KeyConditionExpression} isn't served`);
  }
}

/**
 * Serves an empty table named LIVE_TABLE, read with test credentials, and
 * what's needed to fill it.
 */
export function liveTable() {
  const items: Wire[] = [];
  const queries: z.infer<typeof query>[] = [];
  const updates: z.infer<typeof update>[] = [];

  server.use(
    http.post(ENDPOINT, async ({ request }) => {
      const body = await request.json();

      if (request.headers.get("X-Amz-Target")?.endsWith(".UpdateItem")) {
        const asked = update.parse(body);
        updates.push(asked);
        added(items, asked);

        return HttpResponse.json(
          {},
          { headers: { "Content-Type": "application/x-amz-json-1.0" } }
        );
      }

      const asked = query.parse(body);
      queries.push(asked);

      const found = items
        .filter((item) => matches(item, asked))
        .sort((a, b) => (a.sk?.S ?? "").localeCompare(b.sk?.S ?? ""));

      if (asked.ScanIndexForward === false) found.reverse();
      const Items = found.slice(0, asked.Limit);

      return HttpResponse.json(
        { Items, Count: Items.length },
        { headers: { "Content-Type": "application/x-amz-json-1.0" } }
      );
    })
  );

  return {
    queries,
    updates,

    /** The item at `pk`/`sk`, as it's stored. */
    item(pk: string, sk: string) {
      return items.find((item) => item.pk?.S === pk && item.sk?.S === sk);
    },

    /** Stores `data` as `c`'s item at `sk`, as the poller would. */
    seed<C extends Collection>(
      c: C,
      sk: LiveRecord<C>["sk"],
      data: LiveData<C>,
      written = Date.now()
    ) {
      const encoded = z.encode(c.schema, toRecord(c, sk, data, written));

      // SAFETY: liveRecords' schemas encode to attribute maps, of strings
      // but for the gzipped data.
      const attributes = encoded as Record<
        string,
        { S?: string; N?: string; B?: Uint8Array }
      >;

      items.push(
        Object.fromEntries(
          Object.entries(attributes).map(([name, { B, ...value }]) => [
            name,
            B ? { B: Buffer.from(B).toString("base64") } : value,
          ])
        )
      );
    },

    /** Stores `item` as it is. */
    seedItem(item: Wire) {
      items.push(item);
    },
  };
}

/** Answers every query as a role without access would be. */
export function tableDenied() {
  server.use(
    http.post(ENDPOINT, () =>
      HttpResponse.json(
        {
          __type: "com.amazonaws.dynamodb.v20120810#AccessDeniedException",
          message: "not authorized to perform: dynamodb:Query",
        },
        {
          status: 400,
          headers: { "Content-Type": "application/x-amz-json-1.0" },
        }
      )
    )
  );
}
