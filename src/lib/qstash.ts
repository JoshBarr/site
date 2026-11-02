import type { NextApiRequest } from "next";
import { Receiver } from "@upstash/qstash";
import { z } from "zod";

// For API routes QStash calls on a schedule. They need
// `config.api.bodyParser = false`: QStash signs the raw body.

/** Whether the signing keys are set, so requests can be checked. */
export const canVerify = () =>
  !!(
    process.env.QSTASH_CURRENT_SIGNING_KEY &&
    process.env.QSTASH_NEXT_SIGNING_KEY
  );

/** Whether a request really came from QStash. */
export async function verifyQStash(req: NextApiRequest) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) chunks.push(Buffer.from(chunk));

  const signature = z.string().safeParse(req.headers["upstash-signature"]);

  if (!signature.success) return false;

  return new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
  })
    .verify({
      signature: signature.data,
      body: Buffer.concat(chunks).toString("utf8"),
    })
    .catch(() => false);
}
