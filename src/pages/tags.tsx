import React from "react";
import Link from "next/link";
import Layout from "../components/layout";
import SEO from "../components/seo";
import { GetStaticProps } from "next";
import { getAllPostsByTag, PostMetaWithFrontMatter } from "../lib/blog";

interface TagsPageProps {
  postsByTag: {
    name: string;
    slug: string;
    count: number;
    posts: PostMetaWithFrontMatter[];
  }[];
}

const Tags: React.FC<TagsPageProps> = ({ postsByTag }) => (
  <Layout>
    <SEO title="Tags" thumbnail={undefined} />
    <div className="container generic-page ">
      <h1 className="section-top theme-text theme-display-weight space--large">
        Articles by tag
      </h1>
      <ul className="list-inline font-primary">
        {postsByTag.map((tag) => (
          <li>
            <Link
              key={tag.name}
              href={`/tags/${tag.slug}`}
              className="shadow pill pill--large theme-link theme-border-link space"
            >
              {tag.name}{" "}
              <span className="counter theme-border-link theme-link__brand">
                {tag.count}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  </Layout>
);

export default Tags;

export const getStaticProps: GetStaticProps<TagsPageProps> = async () => {
  const postsByTag = await getAllPostsByTag();

  return {
    props: {
      postsByTag,
      isDark: true,
    },
  };
};
