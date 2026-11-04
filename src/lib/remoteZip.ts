import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { createInflateRaw } from "node:zlib";

// Reading text files out of a zip on a server that answers range requests,
// without downloading the rest: the central directory from the end of the
// zip, then only the bytes of the files wanted, inflated as they arrive.
// Zip64 isn't read: nothing here is near 4 GB.

const TIMEOUT = 30_000;

/** The end of central directory record, and the longest comment after it. */
const TAIL = 22 + 0xffff;

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

interface Entry {
  method: number;
  compressedSize: number;
  /** Where its local header starts. */
  offset: number;
}

export interface RemoteZip {
  url: string;
  /** Which version of the zip this is: every read after is of the same one. */
  etag: string;
  entries: Map<string, Entry>;
}

/** `range` of `url`, or with `etag`, null if the zip's still that one. */
async function fetchRange(
  url: string,
  range: string,
  headers: Record<string, string> = {}
) {
  const response = await fetch(url, {
    headers: { Range: `bytes=${range}`, ...headers },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (response.status === 304) return null;

  if (response.status !== 206) {
    throw new Error(`${url} ${range}: HTTP ${response.status}`);
  }

  return response;
}

/**
 * The zip at `url`, as far as its directory: null if its ETag is still
 * `etag`.
 */
export async function openZip(
  url: string,
  etag?: string | null
): Promise<RemoteZip | null> {
  const response = await fetchRange(
    url,
    `-${TAIL}`,
    etag ? { "If-None-Match": etag } : {}
  );

  if (!response) return null;

  const version = response.headers.get("ETag");

  if (!version) throw new Error(`${url}: no ETag`);

  const total = Number(response.headers.get("Content-Range")?.split("/")[1]);
  let tail = Buffer.from(await response.arrayBuffer());
  let end = tail.length - 22;

  while (end >= 0 && tail.readUInt32LE(end) !== END_OF_DIRECTORY) end--;

  if (end < 0) throw new Error(`${url}: not a zip`);

  const count = tail.readUInt16LE(end + 10);
  const size = tail.readUInt32LE(end + 12);
  const start = tail.readUInt32LE(end + 16);
  // Where the tail starts in the zip.
  let base = total - tail.length;

  if (start < base) {
    const directory = await fetchRange(url, `${start}-${start + size - 1}`, {
      "If-Match": version,
    });

    tail = Buffer.from(await directory!.arrayBuffer());
    base = start;
  }

  const entries = new Map<string, Entry>();
  let at = start - base;

  for (let i = 0; i < count; i++) {
    if (tail.readUInt32LE(at) !== DIRECTORY_ENTRY) {
      throw new Error(`${url}: bad directory entry ${i}`);
    }

    const nameLength = tail.readUInt16LE(at + 28);
    const name = tail.toString("utf8", at + 46, at + 46 + nameLength);

    entries.set(name, {
      method: tail.readUInt16LE(at + 10),
      compressedSize: tail.readUInt32LE(at + 20),
      offset: tail.readUInt32LE(at + 42),
    });

    at +=
      46 + nameLength + tail.readUInt16LE(at + 30) + tail.readUInt16LE(at + 32);
  }

  return { url, etag: version, entries };
}

/** The lines of the text file `name` in `zip`, read as they arrive. */
async function* zipLines(zip: RemoteZip, name: string) {
  const entry = zip.entries.get(name);

  if (!entry) throw new Error(`${zip.url}: no ${name}`);

  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new Error(`${zip.url}: ${name} is compressed with ${entry.method}`);
  }

  const match = { "If-Match": zip.etag };

  const header = Buffer.from(
    await (await fetchRange(
      zip.url,
      `${entry.offset}-${entry.offset + 29}`,
      match
    ))!.arrayBuffer()
  );

  if (header.readUInt32LE(0) !== LOCAL_HEADER) {
    throw new Error(`${zip.url}: bad header for ${name}`);
  }

  const data =
    entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);

  const response = await fetchRange(
    zip.url,
    `${data}-${data + entry.compressedSize - 1}`,
    match
  );

  // SAFETY: fetch's body is a web ReadableStream; DOM's and Node's types
  // differ only in name.
  const body = Readable.fromWeb(response!.body as ReadableStream);

  const input =
    entry.method === DEFLATED ? body.pipe(createInflateRaw()) : body;

  yield* createInterface({ input, crlfDelay: Infinity });
}

/** One line of a CSV file, its quoted fields unquoted. */
function csvFields(line: string) {
  if (!line.includes('"')) return line.split(",");

  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];

    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
    } else {
      field += c;
    }
  }

  fields.push(field);

  return fields;
}

/**
 * The rows of the CSV file `name` in `zip`, each by its column names: with
 * `where`, only those whose `column` is one of its `values`, checked before
 * the rest of the row's read (a GTFS feed's stop times are 25 MB).
 */
export async function* zipCsv(
  zip: RemoteZip,
  name: string,
  where?: { column: string; values: Set<string> }
) {
  let columns: string[] | null = null;
  let filter = -1;

  for await (const line of zipLines(zip, name)) {
    if (!line) continue;

    // Some files start with a byte order mark.
    const fields = csvFields(columns ? line : line.replace(/^﻿/, ""));

    if (!columns) {
      columns = fields;
      filter = where ? columns.indexOf(where.column) : -1;

      if (where && filter < 0) throw new Error(`${name}: no ${where.column}`);

      continue;
    }

    if (where && !where.values.has(fields[filter])) continue;

    yield Object.fromEntries(
      columns.map((column, i) => [column, fields[i] ?? ""])
    );
  }
}
