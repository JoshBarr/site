import React from "react";
import PostListing from "../components/PostListing";

import Layout from "../components/layout";
import SEO from "../components/seo";
import { GetStaticProps } from "next";
import { getAllPosts, PostMetaWithFrontMatter } from "../lib/blog";

interface BlogIndexProps {
  allPosts: PostMetaWithFrontMatter[];
}

const BlogIndex: React.FC<BlogIndexProps> = ({ allPosts }: BlogIndexProps) => (
  <Layout theme="theme--hero">
    <SEO title="Blog" thumbnail={undefined} />
    <div className="container generic-page">
      <h1 className="page-title section-top theme-text space--large">Blog</h1>

      <div>
        {allPosts.map((post) => {
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

export default BlogIndex;

export const getStaticProps: GetStaticProps<BlogIndexProps> = async () => {
  const allPosts = await getAllPosts();

  return {
    props: {
      allPosts,
      isDark: true,
    },
  };
};
