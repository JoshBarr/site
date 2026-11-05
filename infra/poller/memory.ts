import * as Effect from "effect/Effect";
import { readdirSync, readFileSync } from "node:fs";
import v8 from "node:v8";
import vm from "node:vm";

// What the function's memory is spent on, logged once a minute. Lambda's
// "Max Memory Used" tracks whatever size it's given (127 of 128 MB, then 160
// of 160), but run locally the heap's live set is ~18 MB: this tells the
// heap from native memory, and memory the process owns (anonymous) from
// pages mapped from files (the node binary and the bundle), which the
// kernel can drop and read again rather than run out.
//
// INVESTIGATING (2026-11-06), to take out once it's answered whether the
// poller fits 128 MB: once a container, the flags node was started with and
// the runtime's bootstrap lines that set them; each minute, the sandbox's
// own accounting (cgroup), and the heap's live set after a forced GC.

const mb = (bytes: number) => Math.round(bytes / 1048576);

/** `path`'s text, or null if it can't be read (off Linux, say). */
function read(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The /proc/self/status fields, in MB; empty off Linux. */
function status() {
  const text = read("/proc/self/status") ?? "";

  return Object.fromEntries(
    [
      ...text.matchAll(/^(VmHWM|VmRSS|RssAnon|RssFile|RssShmem):\s+(\d+) kB/gm),
    ].map(([, field, kb]) => [field, Math.round(Number(kb) / 1024)])
  );
}

/** The sandbox's memory cgroup (v2 or v1), in MB, where it can be read. */
function cgroup() {
  const v2 = (file: string) => read(`/sys/fs/cgroup/${file}`);
  const v1 = (file: string) => read(`/sys/fs/cgroup/memory/${file}`);
  const stat = v2("memory.stat") ?? v1("memory.stat") ?? "";

  const field = (name: string) => {
    const match = new RegExp(`^${name} (\\d+)$`, "m").exec(stat);

    return match ? mb(Number(match[1])) : undefined;
  };

  const number = (text: string | null) =>
    text && /^\d+\s*$/.test(text) ? mb(Number(text)) : (text?.trim() ?? null);

  return {
    current: number(v2("memory.current") ?? v1("memory.usage_in_bytes")),
    peak: number(v2("memory.peak") ?? v1("memory.max_usage_in_bytes")),
    max: number(v2("memory.max") ?? v1("memory.limit_in_bytes")),
    anon: field("anon") ?? field("total_rss") ?? field("rss"),
    file: field("file") ?? field("total_cache") ?? field("cache"),
    kernel: field("kernel"),
  };
}

/** The bootstrap's lines about memory or node's options. */
function bootstrap() {
  const lines = (path: string) =>
    (read(path) ?? "")
      .split("\n")
      .filter((line) => /space|memory|NODE_OPTIONS|exec /i.test(line))
      .map((line) => line.trim());

  let files: string[] = [];

  try {
    files = readdirSync("/var/runtime");
  } catch {
    // Off Lambda.
  }

  return {
    files,
    bootstrap: lines("/var/runtime/bootstrap"),
  };
}

let gc: (() => void) | undefined;

/** The heap's live set, MB: what's left after a full collection. */
function liveHeap() {
  if (!gc) {
    v8.setFlagsFromString("--expose-gc");
    // SAFETY: --expose-gc puts V8's gc() on every new context's global.
    gc = vm.runInNewContext("gc") as () => void;
  }

  gc();

  return mb(process.memoryUsage().heapUsed);
}

let started = false;

const logStart = Effect.suspend(() => {
  if (started) return Effect.void;

  started = true;

  return Effect.log(
    `[memory] start ${JSON.stringify({
      execArgv: process.execArgv,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
      cmdline: read("/proc/self/cmdline")?.split("\0").filter(Boolean),
      memorySize: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
      ...bootstrap(),
    })}`
  );
});

export const logMemory = Effect.suspend(() => {
  const { rss, heapTotal, heapUsed, external, arrayBuffers } =
    process.memoryUsage();

  const before = {
    rss: mb(rss),
    heapTotal: mb(heapTotal),
    heapUsed: mb(heapUsed),
    heapLimit: mb(v8.getHeapStatistics().heap_size_limit),
    external: mb(external),
    arrayBuffers: mb(arrayBuffers),
    ...status(),
    cgroup: cgroup(),
  };

  return logStart.pipe(
    Effect.andThen(
      Effect.log(
        `[memory] ${JSON.stringify({ ...before, liveHeap: liveHeap() })}`
      )
    )
  );
});
