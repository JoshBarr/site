import React from "react";
import Link from "next/link";
import Layout from "../../components/layout";
import SEO from "../../components/seo";
import { GetStaticPaths, GetStaticProps } from "next";
import { getAllPostsByTag, PostMetaWithFrontMatter } from "../../lib/blog";
import PostListing from "../../components/PostListing";

interface TagsPageProps {
  name: string;
  slug: string;
  count: number;
  posts: PostMetaWithFrontMatter[];
}

const Tags: React.FC<TagsPageProps> = ({ name, slug, count, posts }) => (
  <Layout>
    <SEO title="Tags" thumbnail={undefined} />
    <div className="container generic-page ">
      <h1 className="section-top theme-text theme-display-weight space--large">
        Tag: {name}
      </h1>

      <div>
        {posts.map((post) => {
          return (
            <div key={post.slug}>
              <PostListing post={post} />
            </div>
          );
        })}
      </div>
    </div>
  </Layout>
);

export default Tags;

export const getStaticProps: GetStaticProps<TagsPageProps> = async (req) => {
  const postsByTag = await getAllPostsByTag();

  const tag = postsByTag.find((tagGroup) => tagGroup.slug === req.params.slug);

  if (!tag) {
    return {
      redirect: "/tags",
      // bug(types): redirects shouldn't require all props to be set
      props: {} as any,
    };
  }

  return {
    props: {
      isDark: true,
      ...tag,
    },
  };
};

export const getStaticPaths: GetStaticPaths = async () => {
  const postsByTag = await getAllPostsByTag();
  const paths = postsByTag.map((tagGroup) => tagGroup.permalink);

  return {
    paths,
    fallback: "blocking",
  };
};
