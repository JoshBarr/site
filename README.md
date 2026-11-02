# Joshbarr.com

> Website

## Rebuilding the scene's assets

`npm run build:assets` rebuilds everything the Wellington scene is generated from (terrain tiles, trees, land cover, buildings, airport, bus routes, landmarks, port, roads, rail), in dependency order. Pass step names to rebuild only those, e.g. `npm run build:assets -- buses trains`; [scripts/build_assets.sh](scripts/build_assets.sh) lists them. The Python steps set up `.venv-terrain` on first run, and downloads are cached in `.cache/`.

## Live harbour ships

The Wellington scene shows ships in the harbour at their live AIS positions, with trails behind those under way.

- **Source:** [Open Waters AIS](https://openwaters.io/ais/), an open network of shore receivers (with [AISHub](https://www.aishub.net)'s), free for personal use. It keeps every ship's last known state and the positions heard from it, so there's nothing to listen to: one request gives the harbour, and one per ship under way gives its track.
- **`/api/vessels`:** answers from a snapshot in Upstash Redis ([src/lib/vesselStore.ts](src/lib/vesselStore.ts)). When it's 20 seconds old, the first request to take a lock (`SET NX`) fetches a new one, so Open Waters is asked at most three times a minute (plus tracks) however many people are watching. Tracks are fetched from where each ship's trail ends, so each is only the last few positions.
- **Last known good:** the snapshot never expires. If Open Waters is down, the scene keeps showing it: moored ships for up to 12 hours, ships under way until they're 10 minutes out of date.
- **Credits:** Open Waters and AISHub ask to be credited wherever the data is shown; that's in the homepage footer.

## Live buses

The scene also runs Metlink's buses along their routes, with green trails.

- **Source:** Metlink's [open data API](https://opendata.metlink.org.nz) GTFS Realtime vehicle positions, the same feed as the trains (`METLINK_API_KEY`). `/api/buses` keeps trails in Upstash Redis like the trains do ([src/lib/busStore.ts](src/lib/busStore.ts)).
- **Routes:** buses run along the roads their route's trips drive, from the GTFS timetable's shapes, so there's no road network. `node scripts/buses/build_routes.mjs` builds `public/buses/routes.json` (run it after the terrain tiles, which give the heights). Rebuild when Metlink publishes a timetable that changes routes. Until then, a bus that's off every way its route goes runs straight between its fixes.

### Environment

Set these in `.env.local` for development and in the Vercel project for production:

| Variable                                             | From                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Upstash console → Redis. Without them each request fetches from Open Waters itself.                                                    |
| `OPENWATERS_TOKEN` (optional)                        | [openwaters.io/ais/token](https://openwaters.io/ais/token/). Reads work without one, but then share a rate limit with the server's IP. |
