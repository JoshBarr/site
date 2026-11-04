import { crc32, deflateRawSync } from "node:zlib";
import { http, HttpResponse } from "msw/http";
import { GTFS_URL } from "../../src/lib/cablecar";
import { server } from "../msw";

// Metlink's static GTFS feed: a zip, served as its CDN serves it, a range
// at a time, with an ETag that conditional requests are checked against.

/** `files` zipped, each deflated. */
function zip(files: Record<string, string>) {
  const locals: Buffer[] = [];
  const entries: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const path = Buffer.from(name);

    // Version 2.0, UTF-8 names, deflated.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(path.length, 26);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(offset, 42);

    locals.push(local, path, data);
    entries.push(entry, path);
    offset += local.length + path.length + data.length;
  }

  const directory = Buffer.concat(entries);
  const count = Object.keys(files).length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** The bytes `range` (`bytes=a-b`, or `bytes=-n` for the last n) asks for. */
function slice(bytes: Buffer, range: string) {
  const [, from, to] = /^bytes=(\d*)-(\d*)$/.exec(range) ?? [];

  if (!from) {
    const start = Math.max(bytes.length - Number(to), 0);

    return [start, bytes.length - 1];
  }

  return [Number(from), Math.min(Number(to), bytes.length - 1)];
}

/**
 * Serves `files` as the feed, at version `etag`. What was asked for is in
 * `requests`, ranges and conditions.
 */
export function gtfsFeed(files: Record<string, string>, etag = '"feed-1"') {
  const bytes = zip(files);
  const requests: { range: string | null; ifNoneMatch: string | null }[] = [];

  server.use(
    http.get(GTFS_URL, ({ request }) => {
      const range = request.headers.get("Range");
      const ifNoneMatch = request.headers.get("If-None-Match");
      requests.push({ range, ifNoneMatch });

      if (ifNoneMatch === etag) {
        return new HttpResponse(null, { status: 304, headers: { ETag: etag } });
      }

      const ifMatch = request.headers.get("If-Match");

      if (ifMatch && ifMatch !== etag) {
        return new HttpResponse(null, { status: 412 });
      }

      if (!range) {
        return new HttpResponse(bytes, { headers: { ETag: etag } });
      }

      const [start, end] = slice(bytes, range);

      return new HttpResponse(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          ETag: etag,
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        },
      });
    })
  );

  return { requests };
}

/** Rows of a CSV file. */
const csv = (...rows: string[]) => rows.join("\r\n") + "\r\n";

/**
 * A feed as Metlink's has it: the Kāpiti Line, and the cable car on
 * weekdays at 7:30 and 7:40 both ways, and on Saturdays at 9:00. Its
 * weekday service's days are listed one by one, its Saturdays by the week.
 */
export const FEED = {
  "agency.txt": csv(
    "agency_id,agency_name",
    "RAIL,Transdev",
    "WCCL,Wellington Cable Car"
  ),
  "routes.txt": csv(
    "route_id,agency_id,route_short_name,route_long_name,route_type",
    "2,RAIL,KPL,Kāpiti Line (Waikanae - Wellington),2",
    '9,WCCL,CCL,"Cable Car (Kelburn - Wellington)",5'
  ),
  "trips.txt": csv(
    "route_id,service_id,trip_id,trip_headsign,direction_id",
    "2,KPL Weekday,KPL__1__100,Wellington,1",
    "9,CCL Weekday,CCL__1__0730,Lambton Quay,1",
    "9,CCL Weekday,CCL__0__0730,Kelburn,0",
    "9,CCL Weekday,CCL__1__0740,Lambton Quay,1",
    "9,CCL Weekday,CCL__0__0740,Kelburn,0",
    "9,CCL Sa,CCL__1__0900,Lambton Quay,1"
  ),
  "stop_times.txt": csv(
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign",
    "KPL__1__100,07:00:00,07:00:00,WAIK,0,Wellington",
    'CCL__1__0730,07:30:00,07:30:00,KELB,0,"Lambton Quay, via Talavera"',
    "CCL__1__0730,07:31:17,07:31:17,SALA,1,",
    "CCL__1__0730,07:32:26,07:32:26,TALA,2,",
    "CCL__1__0730,07:33:38,07:33:38,CLIF,3,",
    "CCL__1__0730,07:35:00,07:35:00,LAMB,4,",
    // Out of order, as the file needn't have them.
    "CCL__0__0730,07:35:00,07:35:00,KELB,4,",
    "CCL__0__0730,07:30:00,07:30:00,LAMB,0,Kelburn",
    "CCL__0__0730,07:32:33,07:32:33,TALA,2,",
    "CCL__0__0730,07:31:21,07:31:21,CLIF,1,",
    "CCL__0__0730,07:33:42,07:33:42,SALA,3,",
    "CCL__1__0740,07:40:00,07:40:00,KELB,0,",
    "CCL__1__0740,07:45:00,07:45:00,LAMB,1,",
    "CCL__0__0740,07:40:00,07:40:00,LAMB,0,",
    "CCL__0__0740,07:45:00,07:45:00,KELB,1,",
    "CCL__1__0900,09:00:00,09:00:00,KELB,0,",
    "CCL__1__0900,09:05:00,09:05:00,LAMB,1,"
  ),
  "calendar.txt": csv(
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
    "KPL Weekday,1,1,1,1,1,0,0,20261102,20261113",
    "CCL Weekday,0,0,0,0,0,0,0,20261102,20261113",
    "CCL Sa,0,0,0,0,0,1,0,20261102,20261121"
  ),
  "calendar_dates.txt": csv(
    "service_id,date,exception_type",
    "CCL Weekday,20261102,1",
    "CCL Weekday,20261103,1",
    "CCL Weekday,20261104,1",
    // Not the Saturday after next: a closure.
    "CCL Sa,20261114,2"
  ),
  "feed_info.txt": csv(
    "feed_publisher_name,feed_start_date,feed_end_date",
    "Greater Wellington Regional Council,20261102,20261113"
  ),
};
