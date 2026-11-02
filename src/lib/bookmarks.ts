import fs from "fs/promises";
import path from "path";

import { parse } from "yaml";
import { z } from "zod";

const BOOKMARK_PATH = path.join(process.cwd(), "src", "data", "bookmarks.yml");

const bookmarks = z.array(
  z.object({
    title: z.string(),
    description: z.string(),
    category: z.string(),
    url: z.string(),
    date: z.string(),
  })
);

export type Bookmark = z.infer<typeof bookmarks>[number];

export async function getBookmarks() {
  try {
    const bookmarkData = await fs.readFile(BOOKMARK_PATH, "utf-8");
    const parsedBookmarks = bookmarks.parse(parse(bookmarkData));

    const groups: Record<string, Bookmark[]> = {};

    parsedBookmarks.forEach((bookmark) => {
      if (!groups[bookmark.category]) {
        groups[bookmark.category] = [];
      }

      groups[bookmark.category].push(bookmark);
    });

    return Object.entries(groups).map(([name, bookmarks]) => {
      return {
        name,
        bookmarks,
      };
    });
  } catch {
    return [];
  }
}
