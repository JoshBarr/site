import path from "path";
import matter from "gray-matter";
import fs from "fs/promises";
import fsExtra from "fs-extra";
import { kebabCase } from "change-case";
import { z } from "zod";

export const POSTS_PATH = path.join(process.cwd(), "src", "blog");

const MDX_REGEX = /index\.mdx?$/;

const frontMatter = z.object({
  tags: z.array(z.string()),
  title: z.string(),
  blurb: z.string(),
  /** ISO 8601, quoted so YAML leaves it a string. */
  date: z.string(),
  cover_image: z.string().optional(),
  published: z.boolean(),
  authors: z.array(z.string()),
});

export type FrontMatter = z.infer<typeof frontMatter>;

async function getPostFilePaths() {
  const paths = await fs.readdir(POSTS_PATH);

  const dirs: string[] = [];

  for (const filePath of paths) {
    const stats = await fsExtra.stat(path.join(POSTS_PATH, filePath));

    if (stats.isDirectory) {
      if (!path.basename(filePath).startsWith(".")) {
        dirs.push(`${filePath}/index.md`);
      }
    }
  }

  return dirs;
}

function sortByDate(a: FrontMatter, b: FrontMatter) {
  const dateA = new Date(a.date);
  const dateB = new Date(b.date);

  return dateB > dateA ? 1 : -1;
}

function getSlug(filePath: string) {
  return kebabCase(filePath.replace(MDX_REGEX, ""));
}

export async function getPostSlugs() {
  return getPostFilePaths().then((filePaths) =>
    filePaths.map((filePath) => getSlug(filePath))
  );
}

export type PostMetaWithFrontMatter = FrontMatter & {
  slug: string;
  permalink: string;
};

export async function getAllPosts(): Promise<PostMetaWithFrontMatter[]> {
  const postFilePaths = await getPostFilePaths();

  const posts: PostMetaWithFrontMatter[] = [];

  for (const filename of postFilePaths) {
    const fileContents = await fs.readFile(
      path.join(POSTS_PATH, filename),
      "utf8"
    );

    const { data } = matter(fileContents);
    const slug = getSlug(filename);

    posts.push({
      ...frontMatter.parse(data),
      slug,
      permalink: `/blog/${slug}`,
    });
  }

  posts.sort(sortByDate);

  return posts;
}

export async function getPostBySlug(slug: string | string[]) {
  const normalisedSlug = Array.isArray(slug) ? slug.at(0) : slug;

  try {
    const fileContents = await fs.readFile(
      path.join(POSTS_PATH, `${normalisedSlug}/index.md`),
      "utf8"
    );

    const { data, content } = matter(fileContents);

    return { data: frontMatter.parse(data), content };
  } catch {
    return undefined;
  }
}

export async function getAllPostsByTag() {
  const allPosts = await getAllPosts();

  const tags: Record<string, PostMetaWithFrontMatter[]> = {};

  for (const post of allPosts) {
    post.tags.forEach((tag) => {
      if (!tags[tag]) {
        tags[tag] = [];
      }

      tags[tag].push(post);
    });
  }

  return Object.entries(tags).map(([tagName, posts]) => {
    const slug = kebabCase(tagName);

    return {
      name: tagName,
      slug: kebabCase(tagName),
      posts,
      count: posts.length,
      permalink: `/tags/${slug}`,
    };
  });
}
