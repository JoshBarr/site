# Background polling on AWS

Move the live layers' polling off visitor requests and onto a scheduled
Lambda that writes to DynamoDB. Vercel's API routes only read.

**Why:** every store now refreshes inside a visitor's request behind a Redis
lock (`vessels:lock`, `trains:lock`, `buses:lock`, `traffic:lock` +
`waitUntil`), so trails only grow while someone's watching, and the flights
QStash sweep was never scheduled. A poller that runs regardless gives every
visitor full trails, and keeps a history cheap enough to scrub back through
the day at night (notes.md). Upstash's free commands can't cover polling
every 10 s around the clock; DynamoDB's always-free provisioned capacity can,
and caps throughput instead of billing for it.

```
EventBridge Scheduler ── every minute ──▶ Lambda poller (loops ~55 s)
                                            │  Metlink, adsb.lol, Open Waters, NZTA
                                            ▼
                                         DynamoDB  ◀── GetItem ── Vercel /api/* ◀── CDN ◀── visitors
                                                       (OIDC role)
```

## Poller

EventBridge Scheduler's shortest rate is one minute, so one invocation per
minute runs each layer on its own loop until ~52 s in, then flushes history
and exits.

Each layer is polled about as often as its feed changes, and its current
item is written only when the poll brought a newer fix than the stored one.
How often each feed changes was measured 2026-11-03 8:52–8:57 pm NZDT,
polling every 5 s (10 s for vessels):

| layer   | feed changes                                | poll | write        |
| ------- | ------------------------------------------- | ---- | ------------ |
| buses   | continuously: ~95% of buses newer every 5 s | 20 s | every poll   |
| trains  | in one batch every 30 s exactly             | 10 s | ~every 30 s  |
| flights | per aircraft every ~5 s (p90 11 s)          | 10 s | every poll   |
| vessels | under way every ~11 s, moored p90 ~2.5 min  | 60 s | every poll   |
| traffic | speeds move every minute or two             | 60 s | when changed |

- **Buses** never go quiet, so writing only on change saves nothing; 20 s
  is a choice, not the feed's limit. The client draws buses 45 s behind
  along their route shapes, so 20 s fixes lose little.
- **Trains** are polled every 10 s so a batch is caught within 10 s; the
  two polls in three that find nothing new don't write.
- **Flights** can't go faster: adsb.lol answered HTTP 429 to 8 of 60 polls
  at 5 s, and to none in 35 min at 10 s.
- **Vessels** lose no trail detail at 60 s: each poll fetches the track
  from the end of the stored trail (thinned to 10 s anyway). Only the live
  position lags; that's also ~5 Open Waters requests a minute instead of ~15.
- **Traffic** starts first in each invocation (NZTA takes 15–17 s).

Layers are offset within the minute (flights at 0 s, buses at 5 s, trains
at 3 s, vessels at 15 s, traffic at 0 s) so the large writes don't land in
the same second.

Each layer keeps its last snapshot in memory, so a warm container reads
nothing from DynamoDB; a cold one reads the current item once. Writes are
conditional on a `version` attribute, so if two invocations overlap (a late
schedule, a slow NZTA), the loser drops its in-memory copy and re-reads next
time instead of clobbering trails.

No retries anywhere: Scheduler `retryAttempts: 0`, Lambda async
`retryAttempts: 0`. A failed minute is followed by the next one.

The poller is written with Effect. `infra/poller/minute.ts` runs each
feed's loop from its offset until 52 s in, then stores what it polled as
history. Each feed in `infra/poller/feeds.ts` is an `advance(previous)` that
polls it and carries the snapshot on, and a `fixes(next, previous)` that
says what's new for the history; no fixes, no write. Its in-memory state
(current snapshot and version, pending history) lives in `Ref`s made once
per container, in the function's constructor.

`advance` is each store's: `advanceBuses`, `advanceTrains`,
`advanceVessels` (the old `refresh`), `fetchSnapshot` in trafficStore, and
`advanceFlights` (`fetchAirspace` merged into a 30-min fix window, then
`findRoutes`). The poller bundles those straight out of `src/lib`, so
there's one copy of the fetching and trail logic.

Two departures from the Redis stores:

- **Headings** that ships last pointed live in the vessels snapshot
  (`headings`) instead of the `vessels:headings` hash. The Redis path keeps
  the hash until step 4.
- **Flights routes** carry on in the snapshot: each aircraft keeps the route
  found for it, and `findRoutes` is handed those, so a cold container only
  asks adsb.im about callsigns it hasn't seen. Unknown routes (null) aren't
  carried, so they're asked again an hour on, as now. No `route#` items: a
  route only matters while its aircraft is in the 30-min window, which is
  what the snapshot holds.

Upstream keys (Metlink, Open Waters) are `Config.Redacted` values the
function's constructor reads: at deploy, from `.env.local` into the
function's environment; at run time, back out of it into `process.env`,
where `src/lib` looks for them. That's Alchemy's way with secrets, and
needs no parameters or calls at cold start; Lambda encrypts its environment
at rest. (An `AWS.SSM.GetParameter` binding exists, if the keys ought to
leave the environment.)

## Table

One table, `pk` (string) + `sk` (number), TTL attribute `expires`. Payloads
are gzipped JSON in a binary `data` attribute.

| item          | pk                    | sk                  | holds                                        | TTL     |
| ------------- | --------------------- | ------------------- | -------------------------------------------- | ------- |
| current       | `live#buses`          | `0`                 | the snapshot the API serves, with trails     | none    |
| history chunk | `buses#2026-11-03T03` | invocation start ms | every fix polled in that invocation (~1 min) | 30 days |

The current item also has a `version` number: writes are conditional on
it. History chunks hold what each poll brought in the API's own shapes:
vehicles with only their new trail points, aircraft with only their new
fixes (no route), traffic snapshots that changed. History hours are UTC. The sort key is the invocation's start, not the
minute, so overlapping invocations never write the same chunk. Flights'
current item holds the full `HISTORY` (30 min); a request without `?history`
is trimmed to `RECENT` on Vercel.

Nothing ever builds trails from history on request: a 30-min trail from
10 s chunks would be ~900 RCU against 25/s.

### Budget

Measured 2026-11-03 (Tuesday) afternoon, NZDT. Buses, trains and traffic
come from the Redis snapshots at 4:14 pm (243 buses, full 3-min trails).
Flights and vessels come from polling 4:20–4:55 pm at the cadence above,
reusing the stores' own fetch and trail code (flights reached the full
30-min window after 30 min). A write costs 1 WCU per KB; an eventually
consistent read costs 0.5 RCU per 4 KB.

| layer   | current item (gz) | history chunk (gz/min)      | writes    | WCU/s          |
| ------- | ----------------- | --------------------------- | --------- | -------------- |
| buses   | 35 KB             | ~12 KB (from trail density) | 20 s      | 1.75           |
| flights | 25 KB             | 0.9 KB mean, 1.3 max        | 10 s      | 2.5            |
| vessels | 3.5 KB            | 0.5 KB mean, 2.2 first      | 60 s      | 0.07           |
| trains  | 1.4 KB            | < 1 KB                      | 30 s      | 0.07           |
| traffic | 2.6 KB            | 2.6 KB                      | ≤ 60 s    | ≤ 0.05         |
| history | ~16 KB/min, all   |                             | 1 min     | 0.3            |
|         |                   |                             | **total** | **~4.7 of 25** |

- **Flights:** 25 KB was 18 aircraft and ~1,360 fixes over the 30-min
  window (10–12 aircraft in range at a time). Afternoon traffic, before the
  evening peak, so allow ~2× (≈5 WCU/s, ≈7 total) at 5–7 pm. Each sighting
  is ~18 bytes gzipped. Flights are now over half the writes.
- **Vessels:** a quiet harbour: 34–36 ships, only 2–4 under way, ~170
  trail points. Ten ships under way with full 15-min trails would be about
  12 KB. Open Waters requests peaked at 15/min, well under 120.
- **Buses' history chunk** is worked out from the snapshot (≈10 bytes
  gzipped per trail point, ~1,450 fixes a minute), not polled.

- **Reads:** one round of CDN misses (all layers) is ~10 RCU. At the cache
  times below that's ~1 RCU/s per Vercel region while someone's watching,
  and nothing while nobody is. Fine even with several regions.
- **Storage:** history ~23 MB/day → ~0.7 GB at 30 days, of 25 GB.
- **Lambda:** 128 MB × ~55 s × 43,800 invocations/month ≈ 300k of 400k
  GB-s; 44k of 1M requests. 256 MB would go over (~$4/month), so check
  `Max Memory Used` in the REPORT lines before raising it.
- **Egress** is the budget most likely to bite: ~15 GB/month per Vercel
  region if watched 24/7, of AWS's 100 GB free.
- **Scheduler:** 44k of 14M free invocations.

Provisioned at 25/25 assumes no other DynamoDB tables in the region (free
capacity is per account per region). On-demand has no free throughput:
~7 WCU/s would be ~$25/month.

## Reading from Vercel

Vercel functions assume an IAM role through Vercel's OIDC federation and call
`GetItem` / `Query` directly. No Function URL, no static secret, no API
Lambda.

```ts
// src/lib/live.ts
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

// The live layers' current snapshots, as the AWS poller last wrote them
// (see plans/infra.md). Kept per instance for MEMO too, so a burst of CDN
// misses landing on one instance costs one read.

const MEMO = 5_000;

/** Whether there's a table to read; without one, stores fetch upstream. */
export const canRead = () => !!process.env.AWS_ROLE_ARN;

let client: DynamoDBClient | undefined;

const getClient = () =>
  (client ??= new DynamoDBClient({
    region: process.env.AWS_REGION,
    credentials: awsCredentialsProvider({ roleArn: process.env.AWS_ROLE_ARN! }),
  }));

const memo = new Map<string, { at: number; value: Promise<unknown> }>();

export async function getLive<T>(layer: string, schema: z.ZodType<T>) {
  const hit = memo.get(layer);
  if (hit && Date.now() - hit.at < MEMO) return hit.value as Promise<T | null>;

  const value = getClient()
    .send(
      new GetItemCommand({
        TableName: process.env.LIVE_TABLE,
        Key: { pk: { S: `live#${layer}` }, sk: { N: "0" } },
      })
    )
    .then(({ Item }) => {
      if (!Item?.data?.B) return null;
      const result = schema.safeParse(
        JSON.parse(gunzipSync(Item.data.B).toString())
      );
      if (!result.success)
        console.error(`[live] ${layer}:`, z.prettifyError(result.error));

      return result.success ? result.data : null;
    });

  memo.set(layer, { at: Date.now(), value });

  return value;
}
```

Each store's `load*()` becomes `getLive(...)` + the read-time trimming it
already does (stale vehicles, trails older than `TRAIL`). Without
`AWS_ROLE_ARN` (local dev without `vercel env pull`), stores call `advance(null)`
directly, the same as today's `!canStore()` path.

**Caching:** visitors never reach DynamoDB directly; the CDN does, once per
window per region. Buses go from `s-maxage=5` to `s-maxage=10,
stale-while-revalidate=20` (they report every 10 s and are drawn 45 s
behind); the rest keep their current headers. Past history never changes,
so a replay route for a finished hour can be `s-maxage=31536000, immutable`,
which caps playback reads no matter how many people scrub.

**Region:** there's no `vercel.json`, so functions run wherever the project
settings say (Vercel's default is iad1). Put the table and the functions in
the same place: the table in ap-southeast-2 and functions in syd1
(`"regions": ["syd1"]`), close to the NZ upstreams too.

## Alchemy stack

`infra/` is its own package (Alchemy 2 beta, `effect` 4), so Alchemy and
Effect stay out of the site's dependencies. It needs Node 24 (pinned for
Volta). `npm run check` there typechecks the stack, the poller and the
`src/lib` code it bundles (with the site's compiler settings), and runs
`infra/test/` with the site's test setup: the network through MSW, the
table in memory (`infra/test/table.ts`), and the minute's loop under
Effect's `TestClock`. The site's tsconfig leaves `infra/` out; knip treats
it as a second workspace, so the `src/lib` exports only the poller uses
count as used; oxlint and oxfmt cover it from the root.

Declared where they're used:

- **Table** `Live`, in `infra/live.ts`: `pk` S + `sk` N, provisioned 25/25,
  TTL on `expires`, `RemovalPolicy.retain()` so a destroy doesn't lose
  history (a retained table still uses the free capacity, so delete it by
  hand if it's ever orphaned). Both the poller and the stack yield it; it's
  one table.
- **Function** `Poller`, `infra/poller/index.ts`: an Effect function class
  (`AWS.Lambda.Function<Poller>()`), arm64, 128 MB, no function URL, async
  retries 0 / max age 1 min, logs kept 1 day. The minute is interrupted at
  58 s (`timeout`), and Lambda's own timeout is 2 s later
  (`timeoutMargin`), for the interrupted feeds to finish up.
- **Bindings** in its constructor: `AWS.DynamoDB.GetItem(table)` and
  `PutItem(table)`, which grant those two actions on the table and are
  wrapped as the poller's `LiveTable` service, so tests can swap in their
  own.
- **Schedule** from the constructor too, through the
  `AWS.Scheduler.ScheduleEventSource` service rather than `consumeSchedule`:
  `consumeSchedule` drops the retry policy, and Scheduler's default retries
  for a day. `rate(1 minute)`, `MaximumRetryAttempts: 0`,
  `MaximumEventAgeInSeconds: 60`. Alchemy makes its invoke role.
- **Vercel reader**, in `infra/alchemy.run.ts`, once `VERCEL_TEAM` and
  `VERCEL_PROJECT` are in the env file: the OIDC provider
  (`https://oidc.vercel.com/<team>`, audience `https://vercel.com/<team>`)
  and a role it can assume for
  `owner:<team>:project:<project>:environment:*`, allowed `GetItem` and
  `Query` on the table. Its ARN is a stack output, with the table's name.

State is in Alchemy's own on-demand DynamoDB table (`alchemy-state`) in the
same account and region. On-demand, so it doesn't take from the 25/25 free
capacity; a deploy costs fractions of a cent.

Deploying:

```sh
cd infra
npm install
npx alchemy profile edit --add AWS   # once; pick ap-southeast-2
npm run plan
npm run deploy                       # --stage prod --env-file ../.env.local
npm run logs                         # the per-invocation summary lines
```

Each feed logs one line per invocation: polls, writes and the current
item's gzipped size, and the history chunk's fixes and size. The bundle
carries Effect's runtime, so check `Max Memory Used` against 128 MB first.

## Steps

1. **Split the stores.** Lift each store's pure `refresh` into an
   `advance(previous)` (+ `fixes`) the poller can import; leave the Redis
   path working on top of it. No behaviour change; vitest covers `advance`
   with MSW as now.
2. **Poller + table.** `infra/` Alchemy stack, `npm run deploy` to
   ap-southeast-2. Check items appear, watch the gzipped sizes in the
   summary lines, and check `Max Memory Used` and duration in the REPORT
   lines for a day.
3. **Vercel reads.** Enable OIDC (team issuer mode), set `AWS_ROLE_ARN`,
   `AWS_REGION`, `LIVE_TABLE`; pin functions to syd1. Switch the stores to
   `getLive` one layer at a time, comparing against Redis.
4. **Remove Redis and QStash.** `lib/redis.ts`, `lib/qstash.ts`, the lock
   code, `/api/flights/sweep`, `scripts/flights/schedule.mjs`, the
   `@upstash/*` deps and env vars. Deleting the Upstash database is a
   separate decision.
5. **Budget alert** in AWS Budgets at $1/month: only DynamoDB has a hard cap.
6. **Replay** (separate plan): `/api/replay?layer=&hour=` → `Query` one
   hour's chunks, immutable for finished hours; the client scrubber.

## Open questions

- Vercel team slug and project name for the OIDC trust (`VERCEL_TEAM`,
  `VERCEL_PROJECT`), and which region the functions run in now.
- History retention: 30 days as first planned, or 7 if only "scrub back
  through today" is wanted.
- Which AWS free plan the account is on. Since mid-2025, accounts on the
  Free plan close after 6 months unless upgraded; the always-free limits
  above carry on either way.
- Whether adsb.lol and Open Waters answer from AWS IP ranges as they do from
  Vercel's (adsb.lol's trace files are behind a bot check; the point API
  wasn't).
- Flights and vessels were measured on one quiet afternoon. Step 2's
  per-write size logging should check the evening flight peak and a busy
  harbour (ferry departures, cruise ships) before capacity is locked in.
