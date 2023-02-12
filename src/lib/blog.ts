import path from "path";
import matter from "gray-matter";
import fs from "fs/promises";
import fsExtra from "fs-extra";
import { paramCase } from "change-case";

export const POSTS_PATH = path.join(process.cwd(), "src", "blog");

const MDX_REGEX = /index\.mdx?$/;

export type FrontMatter = {
  tags: string[];
  title: string;
  blurb: string;
  date: string;
  cover_image?: string;
  published: boolean;
  authors: string[];
} & Record<string, any>;

export async function getPostFilePaths() {
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
  return paramCase(filePath.replace(MDX_REGEX, ""));
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
    const frontmatter = data as FrontMatter;

    const slug = getSlug(filename);

    posts.push({
      ...frontmatter,
      slug,
      permalink: `/articles/${slug}`,
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

    return { data: data as FrontMatter, content };
  } catch (e) {
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
    const slug = paramCase(tagName);

    return {
      name: tagName,
      slug: paramCase(tagName),
      posts,
      count: posts.length,
      permalink: `/tags/${slug}`,
    };
  });
}
