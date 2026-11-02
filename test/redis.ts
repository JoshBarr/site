import { http, HttpResponse } from "msw/http";
import { z } from "zod";

// Upstash Redis as its REST API serves it, in memory: as much of it as the
// API routes use. Commands are POSTed to the base URL, or in a list to
// /pipeline; string results come back base64-encoded, as the client asks.

const REDIS_URL = "https://redis.test";

const command = z.tuple([z.string()], z.union([z.string(), z.number()]));

type Command = z.infer<typeof command>;

/** A reply as sent: strings base64-encoded, except "OK". */
type Reply = string | number | null | (string | null)[];

const strings = new Map<string, { value: string; expires: number }>();
const sortedSets = new Map<string, Map<string, number>>();
const hashes = new Map<string, Map<string, string>>();

/** Every command run, oldest first, as `["SET", key, ...]`. */
const log: string[][] = [];

function getString(key: string) {
  const entry = strings.get(key);

  if (entry && entry.expires <= Date.now()) strings.delete(key);

  return strings.get(key)?.value ?? null;
}

const text = (value: string | null) =>
  value === null ? null : Buffer.from(value).toString("base64");

/** A score bound as ZRANGE and friends take it. */
function bound(value: string) {
  if (value === "-inf") return -Infinity;

  if (value === "+inf" || value === "inf") return Infinity;

  return Number(value);
}

function set(key: string, value: string, options: string[]): Reply {
  const flags = options.map((o) => o.toLowerCase());

  if (flags.includes("nx") && getString(key) !== null) return null;

  const px = flags.indexOf("px");
  const ex = flags.indexOf("ex");

  let expires = Infinity;

  if (px >= 0) expires = Date.now() + Number(options[px + 1]);

  if (ex >= 0) expires = Date.now() + Number(options[ex + 1]) * 1000;

  strings.set(key, { value, expires });

  return "OK";
}

function run([name, ...rest]: Command): Reply {
  const args = rest.map(String);
  const [key = ""] = args;

  log.push([name.toUpperCase(), ...args]);

  switch (name.toLowerCase()) {
    case "get":
      return text(getString(key));

    case "set":
      return set(key, args[1], args.slice(2));

    case "mget":
      return args.map((k) => text(getString(k)));

    case "zadd": {
      const members = sortedSets.get(key) ?? new Map<string, number>();
      const before = members.size;

      for (let i = 1; i < args.length; i += 2) {
        members.set(args[i + 1], Number(args[i]));
      }

      sortedSets.set(key, members);

      return members.size - before;
    }

    case "zrange": {
      const [, min, max, ...flags] = args;

      if (!flags.some((f) => f.toLowerCase() === "byscore")) {
        throw new Error("fake redis: only ZRANGE BYSCORE is served");
      }

      return [...(sortedSets.get(key) ?? [])]
        .sort(([, a], [, b]) => a - b)
        .flatMap(([member, score]) =>
          score >= bound(min) && score <= bound(max) ? [text(member)] : []
        );
    }

    case "zremrangebyscore": {
      const members = sortedSets.get(key) ?? new Map<string, number>();
      const before = members.size;

      for (const [member, score] of members) {
        if (score >= bound(args[1]) && score <= bound(args[2])) {
          members.delete(member);
        }
      }

      return before - members.size;
    }

    case "hset": {
      const fields = hashes.get(key) ?? new Map<string, string>();
      const before = fields.size;

      for (let i = 1; i < args.length; i += 2) {
        fields.set(args[i], args[i + 1]);
      }

      hashes.set(key, fields);

      return fields.size - before;
    }

    case "hmget":
      return args
        .slice(1)
        .map((field) => text(hashes.get(key)?.get(field) ?? null));

    default:
      throw new Error(`fake redis: ${name} isn't served`);
  }
}

function respond(commands: Command[]) {
  return commands.map((c) => {
    try {
      return { result: run(c) };
    } catch (e) {
      return { error: String(e) };
    }
  });
}

export const redis = {
  handlers: [
    http.post(`${REDIS_URL}/pipeline`, async ({ request }) =>
      HttpResponse.json(respond(z.array(command).parse(await request.json())))
    ),
    http.post(`${REDIS_URL}/multi-exec`, async ({ request }) =>
      HttpResponse.json(respond(z.array(command).parse(await request.json())))
    ),
    http.post(REDIS_URL, async ({ request }) => {
      const [reply] = respond([command.parse(await request.json())]);

      return HttpResponse.json(reply, { status: reply.error ? 400 : 200 });
    }),
  ],

  /** Forgets everything stored, and every command run. */
  reset() {
    strings.clear();
    sortedSets.clear();
    hashes.clear();
    log.length = 0;
  },

  /** Stores `value` at `key` as the client would: as JSON. */
  seed<T>(key: string, value: T) {
    set(key, JSON.stringify(value), []);
  },

  /** What's stored at `key`, as `schema` reads its JSON. */
  read<T>(key: string, schema: z.ZodType<T>) {
    const value = getString(key);

    return value === null ? null : schema.parse(JSON.parse(value));
  },

  /** A sorted set's members, as `schema` reads their JSON, by score. */
  members<T>(key: string, schema: z.ZodType<T>) {
    return [...(sortedSets.get(key) ?? [])]
      .sort(([, a], [, b]) => a - b)
      .map(([member]) => schema.parse(JSON.parse(member)));
  },

  /** Adds members to a sorted set, each as the client would: as JSON. */
  seedSortedSet<T>(key: string, members: { score: number; member: T }[]) {
    const scored = sortedSets.get(key) ?? new Map<string, number>();

    for (const { score, member } of members) {
      scored.set(JSON.stringify(member), score);
    }

    sortedSets.set(key, scored);
  },

  /** Handlers for Redis failing every command, to `server.use()`. */
  down: [
    http.post(`${REDIS_URL}/pipeline`, () =>
      HttpResponse.json({ error: "ERR down" }, { status: 500 })
    ),
    http.post(REDIS_URL, () =>
      HttpResponse.json({ error: "ERR down" }, { status: 500 })
    ),
  ],

  /** Stores a hash's fields, as given. */
  seedHash(key: string, fields: Record<string, string>) {
    hashes.set(key, new Map(Object.entries(fields)));
  },

  /** A hash's fields, as stored. */
  hash(key: string) {
    return Object.fromEntries(hashes.get(key) ?? []);
  },

  /** The commands run with this name, e.g. "SET". */
  commands(name: string) {
    return log.filter(([n]) => n === name);
  },
};
