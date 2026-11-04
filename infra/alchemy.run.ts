import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Live, Positions } from "./live";
import Poller from "./poller/index";
import Timetables from "./timetables/index";

// The scene's live layers on AWS (see ../plans/infra.md): a Lambda polls the
// feeds every minute into DynamoDB and publishes what the site serves to S3,
// behind CloudFront, and another keeps the cable car's timetable there,
// daily; the site's functions read the table as a role Vercel's
// OIDC tokens can assume. Deployed with `npm run deploy`
// from here, to the region of the Alchemy profile (ap-southeast-2).

export default Alchemy.Stack(
  "scene-live",
  { providers: AWS.providers(), state: AWS.state() },
  Effect.gen(function* () {
    // The poller declares the table, its own access to it and its schedule.
    yield* Poller;
    yield* Timetables;
    const table = yield* Live;
    const vercelRoleArn = yield* vercelReader(table);
    const positionsUrl = yield* positionsCdn(yield* Positions);

    return { tableName: table.tableName, vercelRoleArn, positionsUrl };
  })
);

/**
 * CloudFront in front of the positions bucket, which it reads with origin
 * access control: the bucket lets this distribution, and nothing else, get
 * its objects. Its URL is LIVE_POSITIONS_URL's.
 */
const positionsCdn = Effect.fn(function* (bucket: AWS.S3.Bucket) {
  const access = yield* AWS.CloudFront.OriginAccessControl("PositionsAccess", {
    originType: "s3",
  });

  // 10 s, as often as the poller publishes, whatever the object says: so
  // however hard anyone else asks, S3 is asked at most every 10 s per edge.
  // Nothing from the request is in the key, so a query string can't get
  // round it. The object's gzipped already, whatever's accepted.
  const cache = yield* AWS.CloudFront.CachePolicy("PositionsCache", {
    comment: "The scene's live positions, 10 s",
    minTTL: "10 seconds",
    defaultTTL: "10 seconds",
    maxTTL: "10 seconds",
    parametersInCacheKeyAndForwardedToOrigin: {
      EnableAcceptEncodingGzip: false,
      HeadersConfig: { HeaderBehavior: "none" },
      CookiesConfig: { CookieBehavior: "none" },
      QueryStringsConfig: { QueryStringBehavior: "none" },
    },
  });

  const cdn = yield* AWS.CloudFront.Distribution("PositionsCdn", {
    comment: "The scene's live positions",
    origins: [
      {
        id: "positions",
        domainName: bucket.bucketRegionalDomainName,
        s3Origin: true,
        originAccessControlId: access.originAccessControlId,
      },
    ],
    defaultCacheBehavior: {
      targetOriginId: "positions",
      viewerProtocolPolicy: "https-only",
      allowedMethods: ["GET", "HEAD"],
      cachedMethods: ["GET", "HEAD"],
      cachePolicyId: cache.cachePolicyId,
    },
  });

  yield* bucket.bind`AWS.S3.Policy(CloudFront, ${bucket})`({
    policyStatements: [
      {
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: ["s3:GetObject"],
        Resource: [Output.interpolate`${bucket.bucketArn}/live/*`],
        Condition: {
          StringEquals: { "AWS:SourceArn": cdn.distributionArn },
        },
      },
    ],
  });

  return Output.interpolate`${cdn.url}/live/positions.json`;
});

/**
 * A role the site's Vercel functions assume with their OIDC tokens (team
 * issuer mode) to read the table: no keys. Made once VERCEL_TEAM (the team
 * slug) and VERCEL_PROJECT (the project name) are in the env file.
 */
const vercelReader = Effect.fn(function* (table: AWS.DynamoDB.Table) {
  const team = yield* Config.String("VERCEL_TEAM").pipe(Config.option);
  const project = yield* Config.String("VERCEL_PROJECT").pipe(Config.option);

  if (Option.isNone(team) || Option.isNone(project)) return undefined;

  const issuer = `oidc.vercel.com/${team.value}`;
  const audience = `https://vercel.com/${team.value}`;

  const vercel = yield* AWS.IAM.OpenIDConnectProvider("Vercel", {
    url: `https://${issuer}`,
    clientIDList: [audience],
  });

  const role = yield* AWS.IAM.Role("VercelReader", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: vercel.openIDConnectProviderArn },
          Action: ["sts:AssumeRoleWithWebIdentity"],
          Condition: {
            StringEquals: { [`${issuer}:aud`]: audience },
            StringLike: {
              [`${issuer}:sub`]: `owner:${team.value}:project:${project.value}:environment:*`,
            },
          },
        },
      ],
    },
    inlinePolicies: {
      ReadLive: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Resource: [table.tableArn],
          },
        ],
      },
    },
  });

  return role.roleArn;
});
