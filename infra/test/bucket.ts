import type * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { gunzipSync } from "node:zlib";
import { positions } from "../../src/lib/positions";
import { LiveBucket } from "../poller/positions";

// The positions bucket in memory, behind the same operation Alchemy binds in
// Lambda: PutObject.

/** A new, empty bucket, and the LiveBucket over it. */
export function makeBucket() {
  const puts: AWS.S3.PutObjectRequest[] = [];

  const service = LiveBucket.of({
    putObject: (put) =>
      Effect.sync(() => {
        puts.push(put);

        return {};
      }),
  });

  return {
    service,
    puts,

    /** What was last published, as the site reads it. */
    published() {
      const body = puts.at(-1)?.Body;

      if (!(body instanceof Uint8Array)) throw new Error("nothing published");

      return positions.parse(JSON.parse(gunzipSync(body).toString()));
    },
  };
}
