import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";

// The live table (see ../plans/dynamo.md), yielded by the poller, which binds
// it, and by the stack, which grants Vercel's role read access; yielded
// twice, it's still one table. And the bucket the poller publishes to.

/**
 * Fixed provisioned capacity: past 25/25, DynamoDB throttles rather than
 * bills. Kept if the stack goes, so history isn't lost with it.
 */
export const Live = AWS.DynamoDB.Table("Live", {
  partitionKey: "pk",
  sortKey: "sk",
  attributes: { pk: "S", sk: "S" },
  billingMode: "PROVISIONED",
  provisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 25 },
  timeToLiveSpecification: { Enabled: true, AttributeName: "expires" },
}).pipe(Alchemy.RemovalPolicy.retain());

/**
 * What the poller publishes for the site to read: `live/positions.json`.
 * Private: read only through the CloudFront distribution in front of it
 * (../alchemy.run.ts). Nothing else goes in it, so it can go with the
 * stack.
 */
export const Positions = AWS.S3.Bucket("Positions", {
  forceDestroy: true,
  publicAccessBlock: {
    blockPublicAcls: true,
    ignorePublicAcls: true,
    blockPublicPolicy: true,
    restrictPublicBuckets: true,
  },
});
