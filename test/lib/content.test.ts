import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getAllPosts, getAllPostsByTag, POSTS_PATH } from "../../src/lib/blog";

// The site's own content, read as the pages read it: every post's front
// matter has to be what the pages expect.

describe("content", () => {
  it("reads every post", async () => {
    const dirs = await readdir(POSTS_PATH, { withFileTypes: true });
    const posts = await getAllPosts();

    expect(posts).toHaveLength(dirs.filter((d) => d.isDirectory()).length);

    for (const post of posts) {
      expect(Number.isNaN(Date.parse(post.date))).toBe(false);
      expect(post.permalink).toBe(`/blog/${post.slug}`);
    }
  });

  it("groups posts by tag", async () => {
    const tags = await getAllPostsByTag();

    expect(tags.length).toBeGreaterThan(0);

    for (const tag of tags) {
      expect(tag.count).toBe(tag.posts.length);
    }
  });
});
