// What the electronic message signs on State Highways 1 and 2 are showing:
// shared by /api/signs and the scene.

/** What NZTA's signs last showed. */
export interface SignMessages {
  /**
   * By NZTA's id for the sign, as public/roads/signs.json binds them: the
   * message as NZTA marks it up (see parseMessage), "" for a blank sign.
   */
  messages: Record<string, string>;
}

export interface SignsResponse extends SignMessages {
  /** Server clock, epoch ms, so clients can correct for their own. */
  time: number;
  /** When the messages were fetched from NZTA, epoch ms. */
  fetched: number;
}

/** Messages older than this aren't shown: the sign's moved on. */
export const STALE = 30 * 60_000;

/**
 * One line of a sign's page: text set to the left, the middle, and the
 * right (a travel time's minutes).
 */
interface SignLine {
  left: string;
  centre: string;
  right: string;
}

/** A page: its lines, top to bottom. Signs with more than one take turns. */
export type SignPage = SignLine[];

/** Lines a sign shows at once: a page sent with more is shown as two. */
export const PAGE_LINES = 4;

/** Each page of a two-page message shows for this long, s: NZTA's travel-time pages say 5 or 6. */
export const PAGE_TIME = 5;

/** NTCIP's line justifications by number: `[jl2]` left to `[jl4]` right. */
const JUSTIFIED = new Map<string, keyof SignLine>([
  ["2", "left"],
  ["3", "centre"],
  ["4", "right"],
  ["5", "centre"],
]);

/**
 * The pages of a message as NZTA sends it, in NTCIP 1203's markup: `[np]`
 * starts a page, `[nl]` a line, and `[jl4]` sets what follows on its line
 * to the right (2 left, 3 centre). A line with something set right has the
 * rest of it on the left, as travel times are shown: place, then minutes.
 * Any other tag's dropped. Blank pages are dropped; a blank sign has none.
 * A page of more than PAGE_LINES lines is NZTA's two run together (it
 * sends travel-time pages so): it's split near its middle, after a line
 * that ends an entry (one with its minutes), so a heading stays with the
 * line under it.
 */
export function parseMessage(message: string): SignPage[] {
  return message
    .split("[np]")
    .map((page) =>
      page.split("[nl]").map((raw) => {
        const line: SignLine = { left: "", centre: "", right: "" };
        let side: keyof SignLine = "centre";

        for (const part of raw.split(/(\[[^\]]*\])/)) {
          const tag = /^\[jl(\d)\]$/.exec(part);

          if (tag) side = JUSTIFIED.get(tag[1]) ?? side;
          else if (!part.startsWith("[")) line[side] += part;
        }

        if (line.right.trim() && line.centre.trim() && !line.left.trim()) {
          line.left = line.centre;
          line.centre = "";
        }

        return {
          left: line.left.trim(),
          centre: line.centre.trim(),
          right: line.right.trim(),
        };
      })
    )
    .map((page) => {
      // A message ending `[nl]` has an empty last line.
      const lines = [...page];

      while (lines.length && isBlank(lines.at(-1)!)) lines.pop();

      return lines;
    })
    .filter((page) => page.length > 0)
    .flatMap(splitLong);
}

/** A page of more lines than a sign shows, as two; any other, as it is. */
function splitLong(page: SignPage): SignPage[] {
  if (page.length <= PAGE_LINES) return [page];

  // Where the second page could start, the nearest the middle first.
  const starts = Array.from({ length: page.length - 1 }, (_, k) => k + 1)
    .filter((k) => k <= PAGE_LINES)
    .sort(
      (a, b) => Math.abs(a - page.length / 2) - Math.abs(b - page.length / 2)
    );

  const at = starts.find((k) => page[k - 1].right) ?? starts[0];

  return [page.slice(0, at), page.slice(at)];
}

const isBlank = ({ left, centre, right }: SignLine) =>
  !left && !centre && !right;
