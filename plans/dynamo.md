# Live layers in DynamoDB: a log of polls

Replaces the table design in infra.md (a current item per layer, with a
`version`, plus per-minute history chunks) and its steps 3–4. The poller,
Alchemy stack, deploy commands and Vercel OIDC reader in infra.md still
stand; where the two disagree, this file wins.

**Idea:** each poll that brings something new is appended as one item
holding everything that poll fetched. Trails, the current positions and
replay are all the same query over a time range: a longer trail or an
older replay is just a different range.

**Redis is gone.** Upstash, QStash and every Redis path in the stores are
deleted, not kept working alongside: no compatibility, no side-by-side
comparison. The site reads DynamoDB only (and S3 as a fallback).

## Table

One table, `pk` (S) + `sk` (S), TTL attribute `expires` (epoch seconds).
Payloads are gzipped JSON in a binary `data` attribute, with a format
version `v` (N). `sk` is a string because routes and headings need one;
log times are epoch ms zero-padded to 13 digits, which sorts as a string
until 2286. (`sk` was N: changing it replaces the table, fine before the
first deploy.)

| collection | pk                                                 | sk                            | holds                                                      | TTL                    |
| ---------- | -------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- | ---------------------- |
| logs       | `trains`, `buses`, `flights`, `vessels`, `traffic` | poll time, ms                 | everything that poll fetched (below)                       | 30 days                |
| weather    | `weather`                                          | fetch time, ms                | MetService's conditions for the hour                       | 30 days                |
| routes     | `routes`                                           | `<callsign>#<lookup time ms>` | every airport on the callsign's route, or `null` (unknown) | 30 days                |
| headings   | `headings`                                         | `<mmsi>`                      | the heading a ship last pointed                            | 7 days from last write |

Items are written and read through Zod codecs in `src/lib/liveRecords.ts`,
one per collection, between the DynamoDB item (attribute by attribute: `S`,
`N`, the gzipped `B`) and the typed record. `z.encode` checks a record
before it's written, `z.decode` checks an item when it's read; an item with
a `v` the codec doesn't know fails to decode and is skipped. The poller
(Alchemy's bindings) and the site (the AWS SDK) read the same attribute
maps, so both use these.

One partition per collection is fine: with no local secondary indexes
there's no item-collection size limit, and one partition takes 1,000 WCU
and 3,000 RCU a second, far past anything here.

### What a log item holds

| log     | each item                                                                                            | written                      |
| ------- | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| trains  | every train as fetched: one fix each (`fetchTrains`, on the map)                                     | when any train has a new fix |
| buses   | every bus as fetched, with its route and direction (`fetchBuses`, on the map)                        | when any bus has a new fix   |
| flights | every aircraft as fetched: details + one fix (`fetchAirspace`, without `at`), no route               | when any has a new fix       |
| vessels | the harbour as fetched, the track points fetched for ships under way, headings filled in (see below) | every poll (60 s)            |
| traffic | NZTA's speeds (`links`, `legs`)                                                                      | every poll (edge case 2)     |

Vessel items are more than positions: Open Waters' harbour call says where
each ship is now, and the trail comes from a track call per ship under way,
from the end of its trail. Those track points go in the item, or ship
trails become one point a minute instead of every 10 s.

### Format versions

Log items outlive the code that wrote them: 30 days for replay, a trail
window live. And the poller (Alchemy) and site (Vercel) deploy separately,
so for a while the site reads items from a poller older or newer than
itself. Each item has `v`; a read converts the versions it knows and skips
the rest. Live, skipping costs at most one window of trail after a
deploy. Bump `v` only when an item's shape changes in a way old readers
can't parse.

### Weather

Moved off the request path too: the poller fetches MetService's conditions
(`getConditions` in lib/weather.ts, `METSERVICE_API_KEY` into the poller's
config) when the newest weather item is 30 min old or more, and writes
every fetch. `/api/weather` reads the newest (`Limit: 1`, no lower bound),
cached `s-maxage=300, stale-while-revalidate=600`; replay reads the newest
at or before its time. MetService is then asked 48 times a day, wherever
and however much the site is viewed.

### Routes

Looked up by the poller only (the site never calls adsb.im). A new item
per lookup: when a callsign is first seen, and again once its newest item
is over 24 h old. Unknown callsigns get an item with `null`, looked up
again after an hour. Freshness comes from the lookup time in `sk`, never
from the TTL (edge case 13); the 30-day TTL only sets how far back replay
finds routes.

**Each item holds every airport on the route**, not one leg (fixes edge
case 11). The leg is picked when the route is joined to an aircraft, from
its own fixes: the leg it's least out of its way on, and of legs sharing
an airport (A → WLG → B), the one its track is heading along. So the same
callsign arriving and then departing gets each leg right. Airports past
`ROUTE_REACH` are stored already pulled in along the great circle, in
NZTM, as `toRouteEnd` does now.

Reading the route in force at time `t`: `Query pk = routes AND sk BETWEEN
"<callsign>#" AND "<callsign>#<t>"`, `ScanIndexForward: false`, `Limit: 1`.
One per callsign in the window, in parallel, 0.5 RCU each. Vercel
instances keep the ones they've read in memory (as `remembered` in
flightStore does), so most requests read none.

Keep "unknown" (`null`) apart from "not looked up / lookup failed"
(missing, `undefined` in the response): the client keeps the last route it
had when a response has `undefined`.

### Headings

Read and written only by the poller. Written for a ship when it reports a
heading, or its course while under way, and only when that changed (in
whole degrees, so a wandering course isn't a write a minute); each
write resets the 7-day TTL, so a ship is forgotten after a week without
either. Read once on a cold start (`Query pk = headings`).

Before a vessels item is written, moored ships without a heading get the
one remembered, so every log item holds the heading each ship had then and
replay never needs this collection.

## Reading

- **Current positions + trails:** `Query pk = <log> AND sk >= now - window`
  and fold: per vehicle, its fixes across the items, deduped by fix time,
  sorted, trimmed to the trail, stale vehicles dropped. The newest item's
  vehicles are the ones shown.
- **Traffic and weather:** `ScanIndexForward: false`, `Limit: 1`, no lower
  bound.
- **Replay:** the same, with the range moved back.

Windows: trains and buses 3 min (`TRAIL`), vessels 15 min, flights 2 min
(`RECENT`) or 7 min with `?history` (`HISTORY`).

Flights' `HISTORY` was 30 min; it's 7 since 2026-11-04. The scene only
draws ~90 s of a plane's trail (30 s behind live, whole for 20 s, faded
out over 40) and holds a parked aircraft 5 min, so older fixes went
undrawn; a training aircraft circling for longer just has its oldest trail
fade. The log keeps everything for 30 days either way, so longer trails
later are only a wider window (and the scene's fade constants).

Each fold is a pure function in its store (`foldTrains(items, now)` and so
on), replacing `advance*`'s trail-building: the poller stores what it
fetched and builds nothing.

Without AWS credentials (local development), stores fetch upstream
directly and fold that one poll: positions, no trails.

## Fallback: positions.json in S3

**Interim, for a few hours on 2026-11-04:** while the account couldn't create Vercel's
OIDC provider, positions.json became the site's only source. The poller
keeps each feed's window in memory, folds them with `src/lib`'s folds, and
publishes a gzipped `live/positions.json` every 10 s when a feed's written
something, to a private bucket behind CloudFront (origin access control;
the bucket policy allows only that distribution). The API routes read it
from `LIVE_POSITIONS_URL`, the distribution's URL. Redis is gone already. Once the
routes read the table, this goes back to being the fallback below.

At the end of each invocation the poller writes what every API would
serve right then (each layer folded over its window, plus traffic and
weather) to one private S3 object, `live/positions.json`. When a DynamoDB
read fails or throttles, the API serves its layer from that file instead.

- **What it covers:** DynamoDB being unreachable, throttled past the free
  25 RCU, or a bad read deploy. Not the poller stopping: then the file is
  exactly as old as the newest log item.
- **Stale vehicles:** the stores and hooks drop trains and buses after 5
  min and flights after their last fix + 30 s. So that a stale file shows
  something rather than nothing, a response served from the fallback says
  so (`stale: true`), and the client then shows its vehicles where they
  were, without the staleness cut-off.
- **Cost:** one PUT a minute, ~44k a month, ~$0.25 at S3's standard price
  (the free tier's 2,000 PUTs don't cover it). Read with the same OIDC role
  as the table (`s3:GetObject` on that one key).

## Watching the poller

No paging: this is a homepage. One CloudWatch alarm (free up to 10), to
email via SNS on state change only, so at most a message when it breaks
and one when it recovers:

- `Errors` ≥ 1 or `Invocations` < 1, in each of 3 consecutive 10-min
  periods, missing data treated as breaching.

The per-feed summary lines in the logs (kept a day) say which feed's
failing.

## Edge cases carried over from the Redis stores

Checked against `src/lib/*Store.ts`, the API routes and the client hooks.

1. **Last known good.** Redis snapshots never expire, so a failed fetch
   serves the last one. Trains and buses go stale after 5 min anyway, so a
   windowed query loses nothing. **Vessels** don't: moored ships are shown
   for up to 12 h after they were last heard (`STALE_STATIONARY`), and the
   harbour call returns them every poll. If the poller stops for more than
   the 15-min window, a windowed query finds no items and the harbour
   empties. Read the newest vessels item with `Limit: 1` and no lower bound
   for the ships, then the window for trails.
2. **Traffic staleness is by write time.** The client drops speeds once
   `time - fetched` passes 20 min (`STALE` in lib/traffic.ts). If traffic
   were written only on change, `fetched` would be the last change, and a
   quiet night's unchanged speeds would be dropped as stale. Write every
   poll (2.6 KB a minute; ~110 MB at 30 days).
3. **Fix time is not poll time.** Trails and staleness go by each fix's
   own time; `sk` is when it was fetched. A fix fetched at `sk` has
   `time <= sk` give or take the upstream's clock, so query from a minute
   before the window and filter on fix time.
4. **The same fix is in several items.** Trains report every 30 s and are
   polled every 10 s; aircraft re-report a position (`seen_pos`). Dedupe by
   (vehicle, fix time). Flight fix times are already rounded to whole
   seconds so re-reports collide; keep that.
5. **A bus that changes trip drops its trail** (`sameTrip` in
   `advanceBuses`). Every bus fix carries `route` and `direction`, so the
   fold keeps only fixes since the last change.
6. **Vessel tracks resume from the trail's end.** The poller fetches each
   ship's track from its last trail point in the window, or the whole 15
   min if it's new or was moored. A failed track call, or a ship past
   `MAX_TRACKS` (30), just resumes further back next minute; the fold
   dedupes overlapping track points by time and thins to `TRAIL_STEP`
   (10 s). On a cold start the poller fetches the whole 15 min for each
   ship under way rather than reading the window for the ends; the fold
   dedupes what overlaps.
7. **Headings kept for good → a week.** `vessels:headings` never expired;
   plenty of small craft only ever send a course while under way. After a
   week without one, a moored ship is drawn pointing north until it moves.
8. **Gaps can't be filled for flights.** adsb.lol keeps no history, and
   `/api/flights` used to fetch live on every CDN miss too. With the poller
   the only source, a failed minute (no retries) is a minute-long straight
   line in a trail. Trains and buses the same; vessels refill gaps up to
   15 min from the track call.
9. **Freshness budget.** Vehicles are drawn behind live so there's nearly
   always a fix ahead to interpolate towards: planes 30 s, buses 45 s. A
   fix arrives aged by its report (a few seconds), the poll interval, and
   the CDN (`s-maxage` + `stale-while-revalidate` at worst).
   - Flights: cache `10, 10` since 2026-11-04 (was `15, 20`). Usually ~20
     s old, past 30 s only when served stale, where `EXTRAPOLATE` (30 s of
     dead reckoning) carries the plane on.
   - Buses: cache `10, 10` (was `5, 10`). ~5 + 20 + 10 = 35 s usually, 45
     s served stale: right at the limit.
10. **CDN caching needs fixed windows.** A per-client "since my last
    poll" makes every request a cache miss, so every layer serves its
    current state over a fixed window (flights' `RECENT` is a fixed window
    too). Replay ranges the same: whole aligned chunks (an hour, say), so a
    finished chunk is `immutable` and read from DynamoDB once.
11. **Flight routes picked one leg by position, once.** adsb.im returns
    every airport a callsign stops at; `toRoute` picked the leg the
    aircraft was least out of its way on where it was when looked up, and
    that leg was kept for a day. A callsign through Wellington (A → WLG →
    B), looked up arriving, then showed the arriving leg departing too.
    Fixed by storing every airport and picking the leg per aircraft
    (Routes, above).
12. **Callsign-less aircraft** have `route: null` outright; nothing to look
    up.
13. **DynamoDB TTL isn't prompt.** Expired items are deleted within a few
    days. Logs don't care (reads are by range); routes and headings go by
    their own times (routes by lookup time; a lingering heading does no
    harm).
14. **Overlapping invocations** (a late schedule, a slow NZTA) both append.
    Same feed, same millisecond would overwrite an identical item; anything
    else is two items a few seconds apart, which the fold dedupes. No
    `version`, no conditional writes, no lost-write handling.
15. **Query pages are 1 MB.** Live windows are well under; long replay
    ranges (30 min of buses is ~1 MB) must follow `LastEvaluatedKey`, as
    must any live window widened later.
16. **Replay and the bus route shapes.** Buses are drawn along GTFS shapes
    from `routes.json`, rebuilt when the timetable changes. Replaying from
    before a change can put buses on shapes that have moved. Fine to
    ignore, but worth knowing.

Gone with Redis: the refresh locks, `waitUntil` refreshes in visitor
requests, the flights sightings sorted set and its trimming, the route
cache keys, the `vessels:headings` hash, the QStash sweep
(`/api/flights/sweep`, `lib/qstash.ts`, `scripts/flights/schedule.mjs`),
`lib/redis.ts`, the `@upstash/*` dependencies and env vars, and the fake
Upstash in the tests.

## Budget

Estimated, eventually consistent reads (0.5 RCU per 4 KB; a Query rounds
its total, BatchGet/Get each item). Bus and flight item sizes are guesses
until measured (step 1).

| log              | item (gz) | writes         | WCU/s        | window read per CDN miss | cache | RCU/s per region |
| ---------------- | --------- | -------------- | ------------ | ------------------------ | ----- | ---------------- |
| buses            | ~10–15 KB | 20 s           | ~0.6         | 3 min, ~14 RCU           | 10 s  | ~1.4             |
| flights          | ~1 KB     | 10 s           | ~0.1         | 2 min ~1.5 (+ routes)    | 10 s  | ~0.7             |
| vessels          | ~3 KB     | 60 s           | ~0.05        | 15 min, ~6 RCU           | 10 s  | ~0.6             |
| trains           | < 1 KB    | ~30 s          | ~0.03        | 3 min, ~1 RCU            | 5 s   | ~0.2             |
| traffic          | 2.6 KB    | 60 s           | ~0.05        | 1 item, 0.5 RCU          | 30 s  | ~0               |
| weather          | < 1 KB    | 30 min         | ~0           | 1 item, 0.5 RCU          | 300 s | ~0               |
| routes, headings | tiny      | a few a minute | < 0.1        |                          |       |                  |
|                  |           | **total**      | **~1 of 25** |                          |       | **~3 of 25**     |

- Flights' 7-min `?history` read is ~42 items, ~6 RCU + ~6 for routes,
  once per page load (and cached).
- Burst capacity (5 min of unused throughput) absorbs page-load spikes.
- Storage ~2 GB at 30 days (buses ~1.5 GB), of 25 GB free.
- S3: ~$0.25/month in PUTs; the only cost outside the free tier.
- Past the free tier, provisioned capacity costs a few dollars a month per
  25 RCU, ~5× that per WCU (from memory; check ap-southeast-2 pricing).

## Steps

0. **Check the upstreams answer AWS.** adsb.lol, adsb.im, Open Waters and
   MetService from a Lambda (or `curl` on an instance) in ap-southeast-2,
   as they do from Vercel. Everything else depends on it.
1. **Measure** one poll's gzipped item for each feed (buses and flights at
   the evening peak), to firm up the budget.
2. **Rework the poller.** Done 2026-11-04 and deployed (table, Lambda,
   schedule), except `positions.json` and the alarm. Per feed: fetch,
   compare fix times with the last item written, append if new. Weather, routes (every airport) and
   headings collections; `v` on every item; `positions.json` to S3 after
   each invocation. Drop the current item, `version`, conditional writes
   and per-minute history buffering. `sk` to S. The alarm and SNS topic in
   the stack. Tests in `infra/test/` as now.
3. **Site reads DynamoDB; Redis deleted.** Done 2026-11-04: `src/lib/live.ts`
   reads each window through the Vercel OIDC role (`src/lib/liveTable.ts`)
   and folds it, falling back on `positions.json` (via CloudFront, cached
   10 s) when the table can't be read. Folds in `src/lib` (pure
   functions from items to what each API returns, tested with the same
   fixtures), the leg choice at join time, the S3 fallback and `stale`
   flag, `/api/weather` from the table, bus cache to `10, 10`. Everything
   in "Gone with Redis" deleted in the same change; the API tests move
   from the fake Upstash to a fake table.
4. **Deploy.** infra.md's deploy commands, then Vercel's OIDC settings
   (`AWS_ROLE_ARN`, `AWS_REGION`, `LIVE_TABLE`, the bucket), functions
   pinned to syd1. Budget alert in AWS Budgets at $1/month.
5. **Scene clock + replay** (separate plan). Every layer reads one scene
   clock instead of `Date.now()` (the hooks, `isStale`, each layer's drawn
   time; the sun already takes `?t=`), and replay loads aligned chunks,
   immutable once finished, weather included.
