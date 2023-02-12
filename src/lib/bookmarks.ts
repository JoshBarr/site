import fs from "fs/promises";
import path from "path";

import { parse } from "yaml";

const BOOKMARK_PATH = path.join(process.cwd(), "src", "data", "bookmarks.yml");

export interface Bookmark {
  title: string;
  description: string;
  category: string;
  url: string;
  date: string;
}

export async function getBookmarks() {
  try {
    const bookmarkData = await fs.readFile(BOOKMARK_PATH, "utf-8");
    const parsedBookmarks = parse(bookmarkData) as Bookmark[];

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
