import type { NextApiRequest, NextApiResponse, PageConfig } from "next";
import { z } from "zod";
import {
  countersFor,
  dayOf,
  FRAMES_PK,
  FRAMES_TTL,
  frameReport,
} from "../../lib/frames";
import { addOne, canRead } from "../../lib/liveTable";

/** A beacon's body: parsed by Next as JSON, or as text if it's sent so. */
const beacon = z.union([
  frameReport,
  z
    .string()
    .transform((text, context) => {
      try {
        return JSON.parse(text);
      } catch {
        context.addIssue({ code: "custom", message: "not JSON" });

        return z.NEVER;
      }
    })
    .pipe(frameReport),
]);

/**
 * A visit's frame times from the homepage scene (lib/frames.ts), added to
 * the day's counts in the live table. The scene sends it with
 * navigator.sendBeacon, which doesn't look at the answer.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ error: string }>
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "POST a report" });

    return;
  }

  const report = beacon.safeParse(req.body);

  if (!report.success) {
    res.status(400).json({ error: z.prettifyError(report.error) });

    return;
  }

  if (canRead()) {
    try {
      await addOne(
        FRAMES_PK,
        dayOf(Date.now()),
        countersFor(report.data),
        FRAMES_TTL
      );
    } catch (e) {
      console.error("[frames] not counted:", e);
      res.status(502).json({ error: "not counted" });

      return;
    }
  }

  res.status(204).end();
}

export const config: PageConfig = {
  api: { bodyParser: { sizeLimit: "1kb" } },
};
