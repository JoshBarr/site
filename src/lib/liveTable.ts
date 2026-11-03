import {
  type AttributeValue,
  DynamoDBClient,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/client-dynamodb";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { z } from "zod";
import { type LiveRecord, sortTime } from "./liveRecords";

// The live table the AWS poller writes (see plans/dynamo.md), read through
// the same schemas it writes with (./liveRecords.ts). On Vercel, as the role
// its OIDC tokens assume (AWS_ROLE_ARN); without one, with whatever
// credentials the AWS SDK finds.

type Item = Record<string, AttributeValue>;

/** A collection, as ./liveRecords.ts defines them. */
interface Collection {
  pk: string;
  schema: z.ZodType<{ sk: unknown; data: unknown }, Item>;
}

/** Whether there's a table to read. */
export const canRead = () => !!process.env.LIVE_TABLE;

let client: DynamoDBClient | undefined;

function getClient() {
  const roleArn = process.env.AWS_ROLE_ARN;

  client ??= new DynamoDBClient({
    region: process.env.AWS_REGION ?? "ap-southeast-2",
    ...(roleArn && { credentials: awsCredentialsProvider({ roleArn }) }),
  });

  return client;
}

/**
 * `c`'s items the query finds, as it reads them, a page at a time. Those it
 * can't read (written by another version of the poller, say) are left out.
 */
async function query<C extends Collection>(
  c: C,
  input: Omit<QueryCommandInput, "TableName">
) {
  const records: LiveRecord<C>[] = [];
  let start: Item | undefined;

  do {
    const { Items = [], LastEvaluatedKey } = await getClient().send(
      new QueryCommand({
        ...input,
        TableName: process.env.LIVE_TABLE,
        ExclusiveStartKey: start,
      })
    );

    for (const item of Items) {
      const result = z.safeDecode(c.schema, item);

      if (result.success) {
        // SAFETY: c.schema reads LiveRecord<C>; Collection only widens it.
        records.push(result.data as LiveRecord<C>);
      } else {
        console.warn(`[live] skipped ${c.pk} ${item.sk?.S}`);
      }
    }

    start = input.Limit ? undefined : LastEvaluatedKey;
  } while (start);

  return records;
}

/** `c`'s items since `from` (epoch ms), up to `to` if given, oldest first. */
export const readSince = <C extends Collection>(
  c: C,
  from: number,
  to?: number
) =>
  query(c, {
    KeyConditionExpression:
      to === undefined
        ? "pk = :pk AND sk >= :from"
        : "pk = :pk AND sk BETWEEN :from AND :to",
    ExpressionAttributeValues: {
      ":pk": { S: c.pk },
      ":from": { S: sortTime(from) },
      ...(to !== undefined && { ":to": { S: sortTime(to) } }),
    },
  });

/**
 * `c`'s newest item, of those whose sort key starts with `prefix`, and if
 * `at` is given, of those from then or before (sort keys that are times
 * after the prefix): null if there's none, or it isn't one `c` reads.
 */
export async function readNewest<C extends Collection>(
  c: C,
  prefix = "",
  at?: number
) {
  // Key values can't be empty strings, so no prefix is no condition on it.
  const sk =
    at === undefined
      ? prefix && "begins_with(sk, :prefix)"
      : prefix
        ? "sk BETWEEN :prefix AND :to"
        : "sk <= :to";

  const [record] = await query(c, {
    KeyConditionExpression: sk ? `pk = :pk AND ${sk}` : "pk = :pk",
    ExpressionAttributeValues: {
      ":pk": { S: c.pk },
      ...(prefix && { ":prefix": { S: prefix } }),
      ...(at !== undefined && { ":to": { S: prefix + sortTime(at) } }),
    },
    ScanIndexForward: false,
    Limit: 1,
  });

  return record ?? null;
}
